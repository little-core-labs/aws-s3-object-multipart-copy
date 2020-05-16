const { Destination, Session, Source } = require('./')
const { S3 } = require('aws-sdk')
const copy = require('./')
const test = require('tape')

test('session', (t) => {
  const s3 = new S3()
  const session = new Session({ s3 })
  t.end()
})
