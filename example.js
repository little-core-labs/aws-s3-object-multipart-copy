const { computePartSize, Session } = require('./')
const { MultiBar, Presets } = require('cli-progress')
const { S3 } = require('aws-sdk')
const copy = require('./')

const s3 = new S3()

main().catch(console.error)

// node example.js ...<src> <dst>
async function main() {
  const session = new Session({ s3 })
  const multibars = {}
  const multibar = new MultiBar({
    clearOnComplete: false,
    format: '{filename} | [{bar}] {percentage}% | ETA: {eta}s'
  }, Presets.shades_grey)

  const args = process.argv.slice(2)

  for (let i = 0; i < args.length; i += 2) {
    const [ src, dst ] = args.slice(i, i + 2)
    session.add(src, dst)
  }

  session.on('progress', (data) => {
    const { upload } = data.value

    if (!multibars[upload.id]) {
      multibars[upload.id] = multibar.create(100, 0, { filename: upload.key })
    } else {
      multibars[upload.id].update(upload.progress, { filename: upload.key })
    }
  })

  return session.run()
}

