'use strict'

module.exports = createTransactionMiddleware

const db = require('../db/session')
const Promise = require('bluebird')

function createTransactionMiddleware () {
  return {
    processView (request, match, context) {
      if (match.controller[match.name].noTransaction) {
        return
      }
      const oldRunFunction = match.execute
      match.execute = db.transaction(() => {
        return oldRunFunction()
      })
    }
  }
}