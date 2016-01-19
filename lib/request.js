'use strict'

module.exports = makeKnorkRequest

const Writable = require('stream').Writable
const range = require('range-parser')
const Promise = require('bluebird')
const accepts = require('accepts')
const crypto = require('crypto')
const uuid = require('uuid')
const url = require('url')

const KNORK_TO_REQ = new WeakMap()
const KNORK_TO_IMPL = new WeakMap()

function makeKnorkRequest (req, server) {
  return new KnorkRequest(req, server)
}

class KnorkRequest {
  constructor (req, server) {
    KNORK_TO_REQ.set(this, req)
    KNORK_TO_IMPL.set(this, new Impl(this, server))
    if (process.env.DEBUG) this.doc = HELP
  }
  static get doc () {
    return HELP
  }
  metric (value) {
    return KNORK_TO_IMPL.get(this).metric(value)
  }
  get raw () {
    KNORK_TO_IMPL.get(this).disableBody(new Error(
      'Cannot read the body if "raw" has been accessed.'
    ))
    return KNORK_TO_REQ.get(this)
  }
  get pipe () {
    return () => {
      return this.raw.pipe.apply(this.raw, arguments)
    }
  }
  get id () {
    return KNORK_TO_IMPL.get(this).getID()
  }
  get body () {
    return KNORK_TO_IMPL.get(this).getBody()
  }
  get headers () {
    return KNORK_TO_REQ.get(this).headers
  }
  get rawHeaders () {
    return KNORK_TO_REQ.get(this).rawHeaders
  }
  get urlObject () {
    return KNORK_TO_IMPL.get(this).getURL()
  }
  get url () {
    return KNORK_TO_REQ.get(this).url
  }
  get query () {
    return KNORK_TO_IMPL.get(this).getURL().query
  }
  get method () {
    return KNORK_TO_REQ.get(this).method
  }
  get httpVersion () {
    return KNORK_TO_REQ.get(this).httpVersion
  }
  getRanges (size) {
    if (size) {
      return range(size, this.headers.range)
    }
    return range(this.headers.range)
  }
  get accept () {
    return KNORK_TO_IMPL.get(this).getAccepts()
  }
}

const ID_SCRATCH_BUFFER = new Buffer(16)

class Impl {
  constructor (kreq, server) {
    this.kreq = kreq
    this.id = (
      server.opts.isExternal
        ? hashIncoming(
            KNORK_TO_REQ.get(kreq).headers,
            server.opts.requestIDHeaders || ['request-id']
          )
        : KNORK_TO_REQ.get(kreq).headers['request-id'] || null
    )
    this.url = null
    this.accept = null
    this.body = null
    this.metrics = server.metrics
    this._getBody = () => getBody(this, KNORK_TO_REQ.get(kreq))
  }
  metric (value) {
    return this.metrics.metric(value)
  }
  getID () {
    if (this.id) {
      return this.id
    }
    uuid.v4(null, ID_SCRATCH_BUFFER)
    this.id = ID_SCRATCH_BUFFER.toString('base64')
    return this.id
  }
  getURL () {
    if (this.url) {
      return this.url
    }
    this.url = url.parse(KNORK_TO_REQ.get(this.kreq).url, true)
    return this.url
  }
  getAccepts () {
    if (this.accept) {
      return this.accept
    }
    this.accept = accepts(KNORK_TO_REQ.get(this.kreq))
    return this.accept
  }
  getBody () {
    if (this.body) {
      return this.body
    }
    this.body = this._getBody()
    return this.body
  }
  disableBody (reason) {
    this._getBody = () => getDisabledBody(reason)
  }
}

function hashIncoming (headers, search) {
  for (var i = 0; i < search.length; ++i) {
    if (search[i].toLowerCase() in headers) {
      break
    }
  }
  if (i === search.length) {
    return null
  }
  const hash = crypto.createHash('sha1').update(
    headers[search[i]]
  ).digest('base64')
  return `${hash}-${generateID()}`
}

function generateID () {
  uuid.v4(null, ID_SCRATCH_BUFFER)
  return ID_SCRATCH_BUFFER.toString('base64')
}

function getBody (impl, req) {
  var resolve = null
  var reject = null
  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })
  var triggered = false
  return getBody

  function getBody () {
    if (!triggered) {
      triggered = true
      collectBody()
    }
    return promise
  }

  function collectBody () {
    var bytesWritten = 0
    const acc = []
    req.pipe(new Writable({
      write (chunk, enc, ready) {
        bytesWritten += chunk.length
        acc.push(chunk)
        if (bytesWritten < impl.maxBodySize) {
          return
        }
        req.unpipe(this)
        this._write = () => {}
        reject(Object.assign(
          new Error(`Request payload is too large.`),
          {statusCode: 413}
        ))
      },
      end () {
        return Promise.try(() => {
          return JSON.parse(Buffer.concat(acc).toString('utf8'))
        }).then(obj => resolve(obj))
          .catch(err => reject(Object.assign(
            err,
            {statusCode: 400}
          )))
      }
    }))
  }
}

function getDisabledBody (reason) {
  return new Promise((_, reject) => {
    setImmediate(() => reject(reason))
  })
}

const HELP = `
# KnorkRequest:

## .pipe(dst):

Pipe the original request to a destination. Disables
automatic body parsing support.

## .raw -> http.IncomingMessage:

Get the original request. Disables automatic body parsing
support.

## .id -> String:

A per-request base64'd uuid.

## .body -> Promise<JSON>:

Attempt to fetch the body as JSON. Fails if the body has been
disabled (by acccessing .raw or .pipe), if the request is too
large, or if the body does not represent JSON. The value will
be cached for future use.

## .headers -> Object<String -> String>:

Get the IncomingMessage headers [1].

## .rawHeaders -> Array<Array<String, String>>:

Get the raw headers, per IncomingMessage [2].

## .urlObject -> URL:

Get the fully parsed request url, as returned by
url.parse(req, true) [3].

## .url -> String:

Get the string representing the full URL.

## .query -> Object<String -> String>:

Get the query portion of the URL, as returned by
querystring.parse [4].

## .method -> String:

Get the original request method, per IncomingMessage [5].

## .httpVersion -> String:

Get the HTTP Version, per IncomingMessage [6].

## .getRanges(size) -> Ranges:

Parse the "Range" header into a series of ranges. See
range-parser for more details [7].

## .accept -> Accept:

Get an accept object for the request, per the accepts 
package. [8]
`