const { EventEmitter } = require('events')
const blake2b = require('blake2b')
const assert = require('nanoassert')
const extend = require('extend')
const debug = require('debug')('aws-s3-object-multipart-copy')
const Batch = require('batch')
const mutex = require('mutexify')
const url = require('url')
const os = require('os')

/**
 * The maximum number of parts in a multipart upload request.
 * @private
 */
const MAX_PARTS = 10000

/**
 * The maximum number of bytes per part in a multipart upload request.
 * @private
 */
const MAX_PART_SIZE = 5 * 1000 * 1000 * 1000

/**
 * An `Error` container for aborted sessions.
 * @class
 * @private
 * @extends Error
 */
class SESSION_ABORTED_ERR extends Error {
  constructor() {
    super('Session aborted')
  }
}

/**
 * The `Part` class is a container for a single partition in a multipart upload.
 * @class
 */
class Part {

  /**
   * `Part` class constructor.
   * @constructor
   * @param {Number} partNumber
   * @param {String} etag
   */
  constructor(partNumber, etag) {
    this.number = partNumber
    this.etag = etag
  }

  /**
   * Converts this instance to a AWS compliant JSON object.
   */
  toJSON() {
    return {
      PartNumber: this.number,
      ETag: this.etag,
    }
  }
}

/**
 * The `Target` class is a container for an S3 object in a bucket.
 * @class
 */
class Target {

  /**
   * `Target` coercion helper.
   * @static
   * @param {Session} session
   * @param {Object|Target|String} opts
   * @return {Target}
   */
  static from(session, opts) {
    if ('string' === typeof opts) {
      const { hostname, pathname } = url.parse(opts)
      opts = { bucket: hostname, key: pathname.slice(1) }
    }

    if (opts instanceof this && session === opts.session) {
      return opts
    }

    return new this(session, opts)
  }

  /**
   * `Target` class constructor.
   * @constructor
   * @param {Session} session
   * @param {Object|String} opts
   * @param {String} opts.key
   * @param {String} opts.bucket
   */
  constructor(session, opts) {
    this.key = opts.key
    this.stats = new TargetStats(session, this)
    this.bucket = opts.bucket
    this.session = session
  }

  /**
   * Target content length in bytes.
   * @accessor
   * @type {Number}
   */
  get contentLength() {
    return this.stats.contentLength
  }

  /**
   * Target URI from bucket and key
   * @accessor
   * @type {String}
   */
  get uri() {
    return `s3://${this.bucket}/${this.key}`
  }

  /**
   * Wait for object to be ready.
   * @async
   */
  async ready() {
    if (0 === this.contentLength) {
      await this.stats.load()
    }
  }
}

/**
 * The `TargetStats` class is a container for stats about a target object.
 * @class
 */
class TargetStats {

  /**
   * `TargetStats` class constructor.
   * @constructor
   * @param {Session} session
   * @param {Target} target
   */
  constructor(session, target) {
    this.target = target
    this.session = session
    this.contentLength = 0
  }

  /**
   * Load stats about the target into the instance.
   * @async
   */
  async load() {
    const { s3 } = this.session
    const params = { Bucket: this.target.bucket, Key: this.target.key }
    const head = await s3.headObject(params).promise()
    this.contentLength = parseInt(head.ContentLength)
  }
}

/**
 * The `Destination` class is a container for a destination object in a bucket.
 * @class
 * @extends Target
 */
class Destination extends Target {
  async ready() {}
}

/**
 * The `Source` class is a container for a source object in a bucket.
 * @class
 * @extends Target
 */
class Source extends Target {}

/**
 * The `MultipartUpload` class is a container for a multipart upload request
 * tracking uploaded parts, progress, etc.
 * @class
 */
class MultipartUpload {

  /**
   * `MultipartUpload` class constructor.
   * @constructor
   * @param {Session} session
   * @param {Source} source
   * @param {Destination} destination
   */
  constructor(session, source, destination) {
    this.id = null
    this.key = null
    this.parts = []
    this.total = 0
    this.bucket = null
    this.source = source
    this.pending = 0
    this.session = session
    this.dispatch = source.dispatch
    this.progress = 0
    this.partSize = source.session.config.partSize
    this.destination = destination
  }

  /**
   * Initializes the AWS S3 MultipartUpload request.
   * @async
   */
  async init() {
    const { destination, session, source } = this
    const params = { Bucket: destination.bucket, Key: destination.key }
    let { partSize } = this
    const { s3 } = session

    if (session.aborted) {
      throw new SESSION_ABORTED_ERR()
    }

    let partNumber = 0
    const context = await s3.createMultipartUpload(params).promise()

    await source.ready()
    await destination.ready()

    let total = Math.floor(source.contentLength / partSize)

    if (total > MAX_PARTS) {
      partSize = computePartSize(source.contentLength)
      // recompute
      total = Math.ceil(source.contentLength / partSize) - 1
    }

    this.partSize = partSize
    this.pending = total
    this.bucket = context.Bucket
    this.total = total
    this.key = context.Key
    this.id = context.UploadId

    for (let offset = 0; offset < source.contentLength; offset += partSize) {
      this.upload(++partNumber, offset)
    }
  }

  /**
   * Uploads a part multipart part where `partNumber` is the part index in the
   * multipart upload and `offset` the offset in the source file to upload. The
   * part size
   * @async
   */
  async upload(partNumber, offset) {
    debug('upload(partNumber=%d, offset=%d): %s', partNumber, offset, this.source.key)

    const { partSize, parts } = this
    const { contentLength } = this.source
    const { s3 } = this.session
    const range = { start: 0, end: offset + partSize }

    if (offset > 0) {
      range.start = offset + 1
    }

    if (contentLength < offset + partSize) {
      range.end = contentLength - 1
    }

    const params = {
      CopySourceRange: `bytes=${range.start}-${range.end}`,
      CopySource: `${this.source.bucket}/${this.source.key}`,
      PartNumber: partNumber,
      UploadId: this.id,
      Bucket: this.destination.bucket,
      Key: this.destination.key,
    }

    this.dispatch.push(async (next) => {
      let { retries } = this.session.config

      try {
        if (this.session.aborted) {
          throw new SESSION_ABORTED_ERR()
        }

        const part = await uploadPartCopy()

        this.progress = Math.floor(100 * (1 - (this.pending / this.total)))

        if (0 === this.pending--) {
          this.pending = 0
          this.progress = 100
          const res = await this.complete()
        }

        part.upload = this
        return next(null, part)
      } catch (err) {
        debug(err)
        return next(err)
      }

      async function uploadPartCopy() {
        try {
          debug('uploadPartCopy(%j)', params)
          const res = await s3.uploadPartCopy(params).promise()
          const part = new Part(partNumber, res.ETag)
          parts[partNumber - 1] = part
          return part
        } catch (err) {
          debug(err)

          if (--retries) {
            return uploadPartCopy()
          } else {
            throw err
          }
        }
      }
    })
  }

  /**
   * Completes a multipart upload request.
   * @async
   */
  async complete() {
    if (this.session.aborted) {
      throw new SESSION_ABORTED_ERR()
    }

    const { s3 } = this.session
    const params = {
      MultipartUpload: { Parts: this.parts.map((part) => part.toJSON()) },
      UploadId: this.id,
      Bucket: this.bucket,
      Key: this.key
    }

    return s3.completeMultipartUpload(params).promise()
  }
}

/**
 * The `Session` class is a container for a multipart copy request.
 * @class
 * @extends EventEmitter
 * @see {@link https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#copyObject-property}
 */
class Session extends EventEmitter {

  /**
   * The default maximum number of retries the session instance should retry
   * a multipart upload.
   * @static
   * @accessor
   * @type {Number}
   */
  static get DEFAULT_MAX_RETRIES() { return 4 }

  /**
   * The default part size in bytes for a single chunk of a multipart upload.
   * @static
   * @accessor
   * @type {Number}
   */
  static get DEFAULT_PART_SIZE() { return 5 * 1024 * 1024 }

  /**
   * The number of parallel sources a session will work on.
   * @static
   * @accessor
   * @type {Number}
   */
  static get DEFAULT_SOURCE_CONCURRENCY() { return os.cpus().length }

  /**
   * The total number concurrent multipart chunk uploads.
   * @static
   * @accessor
   * @type {Number}
   */
  static get DEFAULT_PART_CONCURRENCY() {
    return this.DEFAULT_SOURCE_CONCURRENCY * os.cpus().length
  }

  /**
   * An object of defaults for the `Session` class constructor options `opts`
   * parameter.
   * @static
   * @accessor
   * @type {Object}
   */
  static get defaults() {
    return {
      sourceConcurrency: this.DEFAULT_SOURCE_CONCURRENCY,
      concurrency: this.DEFAULT_PART_CONCURRENCY,
      partSize: this.DEFAULT_PART_SIZE,
      retries: this.DEFAULT_MAX_RETRIES,
    }
  }

  /**
   * `Session` class constructor.
   * @constructor
   * @param {?(Object)} opts
   * @param {AWS.S3} opts.s3
   * @param {?(Function)} [opts.factory = MultipartUpload]
   * @param {?(Number)} [opts.concurrency = Session.DEFAULT_PART_CONCURRENCY]
   * @param {?(Number)} [opts.partSize = Session.DEFAULT_PART_SIZE]
   * @param {?(Number)} [opts.retries = Session.DEFAULT_MAX_RETRIES]
   */
  constructor(opts) {
    super()

    opts = extend(true, this.constructor.defaults, opts)

    assert(opts.s3 && 'object' === typeof opts.s3,
      'Invalid argument for `opts.s3`. Expecting an `AWS.S3` instance')

    assert('number' === typeof opts.retries && opts.retries >= 0,
      'Invalid argument for `opts.retries`. Expecting a number >= 0')

    assert('number' === typeof opts.partSize && opts.partSize >= 0,
      'Invalid argument for `opts.partSize`. Expecting a number >= 0')

    assert('number' === typeof opts.concurrency && opts.concurrency >= 0,
      'Invalid argument for `opts.concurrency`. Expecting a number >= 0')

    assert('number' === typeof opts.sourceConcurrency && opts.sourceConcurrency >= 0,
      'Invalid argument for `opts.sourceConcurrency`. Expecting a number >= 0')

    this.s3 = opts.s3
    this.lock = mutex()
    this.queue = null
    this.sources = new Set()
    this.aborted = false
    this.factory = opts.factory || MultipartUpload
    this.dispatch = {}
    this.destinations = new Set()

    this.config = {
      sourceConcurrency: opts.sourceConcurrency,
      concurrency: opts.concurrency,
      partSize: opts.partSize,
      retries: opts.retries,
    }

    this.init()
  }

  /**
   * Initializes the session, configuring the source queue and part dispatch
   * batcher.
   * @async
   */
  init() {
    this.queue = new Batch()
    this.promise = null
    this.aborted = false
    this.dispatch = {}

    this.queue.concurrency(this.config.sourceConcurrency)
  }

  /**
   * Resets session state
   * @async
   */
  async reset() {
    return new Promise((resolve) => {
      this.lock((release) => {
        this.sources.clear()
        this.destinations.clear()
        this.init()
        release(resolve)
      })
    })
  }

  /**
   * Add a source to the session.
   * @param {Object|Source} source
   * @param {Object|Destination} destination
   * @return {Number}
   */
  add(source, destination) {
    if (this.aborted) {
      throw new SESSION_ABORTED_ERR()
    }

    const { destinations, sources, queue } = this

    destination = Destination.from(this, destination)
    source = Source.from(this, source)

    destinations.add(destination)
    sources.add(source)

    const hashId = hash(source.uri + destination.uri)

    this.dispatch[hashId] = new Batch()
    this.dispatch[hashId].concurrency(this.config.concurrency)

    source.dispatch = this.dispatch[hashId]

    queue.push(async (next) => {
      try {
        const multipart = new this.factory(this, source, destination)
        await multipart.init()
        next()
      } catch (err) {
        debug(err)
        next(err)
      }
    })

    return queue.fns.length
  }

  /**
   * Run the session dequeuing each added source running in a specified
   * concurrency.
   * @async
   * @emits progress
   * @emits end
   */
  async run() {
    if (this.promise) {
      return this.promise
    }

    this.promise = new Promise((resolve, reject) => {
      this.lock((release) => {
        for (const key in this.dispatch) {
          const dispatch = this.dispatch[key]
          dispatch.on('progress', (progress) => {
            if (this.aborted) {
              return release(reject, new Error('Session aborted'))
            }

            this.emit('progress', progress)
          })
        }

        this.queue.end((err) => {
          if (err) { return release(reject, err) }
          const waiting = new Batch()

          for (const key in this.dispatch) {
            const dispatch = this.dispatch[key]
            waiting.push((next) =>  dispatch.end(next))
          }

          waiting.end(async (err) => {
            if (this.aborted) {
              if (err) { debug(err) }
              return
            }

            if (err) {
              return release(reject, err)
            } else {
              release()
              resolve(this)
              await this.reset()
              this.emit('end')
            }
          })
        })
      })
    })

    return this.promise
  }

  /**
   * Aborts the running session blocking until the lock is released.
   * @async
   */
  async abort() {
    this.aborted = true
    return new Promise((resolve) => {
      this.lock((release) => release(resolve))
    })
  }

  /**
   * `then()` implementation to proxy to current active session promise.
   * @async
   */
  async then(resolve, reject) {
    if (this.aborted) {
      return reject(new SESSION_ABORTED_ERR())
    }

    if (this.promise) {
      return this.promise.then(resolve, reject)
    } else {
      Promise.resolve().then(resolve, reject)
    }
  }

  /**
   * `catch()` implementation to proxy to current active session promise.
   * @async
   */
  async catch(...args) {
    if (this.promise) {
      return this.promise.catch(...args)
    } else {
      return Promise.resolve()
    }
  }
}

/**
 * Generates a 16 byte Blake2b hash from a given value.
 * @private
 */
function hash(value) {
  return blake2b(16).update(Buffer.from(value)).digest('hex')
}

/**
 * Computes the partition size for a given byte size.
 * @param {Number} contentLength
 * @return {Number}
 */
function computePartSize(contentLength, max) {
  return Math.floor(contentLength / ((max  || MAX_PARTS) - 1))
}

/**
 * Copy a file from source into a destination.
 * @default
 * @param {String|Source} source
 * @param {String|Destination} destination
 * @param {Object} opts
 * @return {Session}
 */
function copy(source, destination, opts) {
  const session = new Session(opts)
  session.add(source, destination)
  session.run().catch((err) => session.emit('error', err))
  return session
}

/**
 * Module exports.
 */
module.exports = Object.assign(copy, {
  computePartSize,
  MultipartUpload,
  TargetStats,
  Destination,
  Session,
  Source,
  Target,
  Part,
})
