aws-s3-object-multipart-copy
============================

> Copy large files in S3 using the [AWS S3 Multipart API][aws-multipart-api].

## Installation

```sh
$ npm install aws-s3-object-multipart-copy
```

## Usage

```js
const { S3 } = require('aws-sdk')
const copy = require('aws-s3-object-multipart-copy')

const s3 = new S3()
const source = 's3://source-bucket/path'
const destination = 's3://destination-bucket/path'

// async
copy(source, destination, { s3 })
  .then(() => { console.log('done') })

// async with emitter
copy(source, destination, { s3 })
  .on('progress', console.log)
  .then(() => { console.log('done') })
```

### Advanced

```js
const { Session, Source } = require('aws-s3-object-multipart-copy')
const { SingleBar } = require('cli-progress')
const { S3 } = require('aws-sdk')

const s3 = new S3()
const progress = new SingleBar()
const session = new Session({ s3 })
const source = Source.from(session, 's3://bucket/path')

progress.start(100, 0
session.add(source, 's3://destination/path')
session.run().on('progress', (e) => {
  progress.update(e.value.upload.progress)
})
```

## API

### `session = copy(source, destination, opts)`

Copy `source` into `destination` where `source` or `destination` can be
a URI or an instance of `Source` and `Destination` respectively. `opts`
can be:

```js
{
  s3: null, // an instance of `AWS.S3` <required>
  retries: 4, // number of max retries for failed uploads [optional]
  partSize: 5 * 1024 * 1024, // the default part size for all uploads in this session [optional]
  concurrency: os.cpus().length * os.cpus().length, // the upload concurrency [optional]
  acl: 'bucket-owner-full-control' // the destination ACL
}
```

### `partSize = computePartSize(contentLength)`

Computes the part size for a given `contentLength`. This is useful if
you want to compute the `partSize` ahead of time. This module will
compute the correct `partSize` for very large files if this number is
too small.

```js
const s3 = new S3()
const session = new Session({ s3 }
const source = Source.from(session, 's3://bucket/path')
await source.ready()
const partSize = computePartSize(source.contentLength)
```

### `class Session`

The `Session` class is a container for a multipart copy request.

#### `session = new Session(opts)`

Create a new `Session` instance where `opts` can be:

```js
{
  s3: null, // an instance of `AWS.S3` <required>
  retries: 4, // number of max retries for failed uploads [optional]
  partSize: 5 * 1024 * 1024, // the default part size for all uploads in this session [optional]
  concurrency: os.cpus().length * os.cpus().length // the upload concurrency [optional]
}
```

#### `totalQueued = session.add(source, destination)`

Add a `source` and `destination` pair to the session queue.

```js
session.add('s3://source/path', 's3://destination/path')
```

#### `await session.run()`

Run the session.

#### `session.abort()`

Aborts the running session blocking until the lock is released.

```js
if (oops) {
  // blocks until all requests have been aborted
  await session.abort()
}
```

#### `session.then()`

`then()` implementation to proxy to current active session promise.

```js
await session
```

#### `session.catch()`

`catch()` implementation to proxy to current active session promise.

```js
session.catch((err) => {
  // handle error
})
```

#### `session.on('progress', event)`

Emitted when a part is uploaded. The object emitted is the same from the
`'progress'` event in the [Batch](https://github.com/visionmedia/batch)
module. The value of `event.value` is a `Part` instance containing
information about the upload (ETag, part number) and a pointer to the
`MultipartUpload` instance at `event.value.upload` which contains
information like how many parts have been uploaded, the progress as a
percentage, and how many parts are pending.

```js
session.on('progress', (event) => {
  console.log(event.value.upload.id, event.value.upload.progress)
})
```

#### `session.on('error', err)`

Emitted when an error occurs during the life time of a running session.

```js
session.run().on('error', (err) => {
  // handle err
})
```

#### `session.on('end')`

Emitted when the session has finished running successfully.

```js
session.run().on('end', () => {
  // session run finished successfully
})
```

### `class Source`

The `Source` class is a container for a source object in a bucket.

#### `source = Source.from(session, uriOrOpts)`

Create a new `Source` instance where `session` is an instance of
`Session` and `uriOrOpts` can be a S3 URI (`s3://bucket/...`) or an
object specifying a bucket and key (`{bucket: 'bucket', key: 'path/to/file'}`).

```js
const source = Source.from(session, 's3://bucket/path')
// or
const source = Source.from(session, { bucket: 'bucket', key: 'path/to/file'})
```

#### `source.key`

The source's key path in the S3 bucket.

#### `source.bucket`

The source's bucket in S3.

#### `source.contentLength`

The size in bytes of the source in S3.

#### `await source.ready()`

Wait for the source to be ready (loaded metadata).

```js
await source.ready()
```

### `class Destination`

The `Destination` class is a container for a destination object in a bucket.

#### `destination = Destination.from(session, uriOrOpts)`

Create a new `Destination` instance where `session` is an instance of
`Session` and `uriOrOpts` can be a S3 URI (`s3://bucket/...`) or an
object specifying a bucket and key (`{bucket: 'bucket', key: 'path/to/file'}`).

```js
const destination = Destination.from(session, 's3://bucket/path')
// or
const destination = Destination.from(session, { bucket: 'bucket', key: 'path/to/file'})
```

#### `destination.key`

The destination's key path in the S3 bucket.

#### `destination.bucket`

The destination's bucket in S3.

#### `await destination.ready()`

Wait for the destination to be ready (loaded metadata).

```js
await destination.ready()
```

### `class MultipartUpload`

The `MultipartUpload` class is a container for a multipart upload request
tracking uploaded parts, progress, etc.

#### `upload = new MultipartUpload(session, source, destination)`

Create a new `MultipartUpload` instance from a `session` where `source` and
`destination` are `Source` and `Destination` instances respectively.

```js
const upload = new MultipartUpload(session, source, destination)
```

#### `upload.id`

The identifier generated for this upload by AWS (`UploadID`).

#### `upload.key`

The destination key of the upload.

#### `upload.parts`

The `Part` instances for each uploaded part in this multipart upload.
Each `Part` contains the ETag for the upload request.

#### `upload.total`

The total number of parts to upload.

#### `upload.bucket`

The destination bucket of the upload.

#### `upload.pending`

The total number of pending parts to upload.

#### `upload.progress`

The progress as a percentage of the multipart upload.

## Tests

> TODO (I am sorry)

## License

MIT

[aws-multipart-api]: https://docs.aws.amazon.com/AmazonS3/latest/dev/mpuoverview.html
