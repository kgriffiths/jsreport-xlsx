import recipe from './recipe.js'
import serialize from './serialize.js'
import shortid from 'shortid'
import fs from 'fs'
import path from 'path'
import Promise from 'bluebird'
import vm from 'vm'
import responseXlsx from './responseXlsx.js'

const FS = Promise.promisifyAll(fs)
let defaultXlsxTemplate

module.exports = (reporter, definition) => {
  // used by html-to-xlsx recipe
  reporter.xlsx = { responseXlsx: responseXlsx }

  reporter.extensionsManager.recipes.push({
    name: 'xlsx',
    execute: () => {}
  })

  if (reporter.compilation) {
    reporter.compilation.resource('defaultXlsxTemplate.json', path.join(__dirname, '../static', 'defaultXlsxTemplate.json'))
    reporter.compilation.resource('helpers.js', path.join(__dirname, '../static', 'helpers.js'))
  }

  reporter.options.tasks.modules.push({
    alias: 'fsproxy.js',
    path: path.join(__dirname, '../lib/fsproxy.js')
  })

  reporter.options.tasks.modules.push({
    alias: 'lodash',
    path: require.resolve('lodash')
  })

  reporter.options.tasks.modules.push({
    alias: 'xml2js',
    path: require.resolve('xml2js')
  })

  if (reporter.options.tasks.allowedModules !== '*') {
    reporter.options.tasks.allowedModules.push('path')
  }

  reporter.documentStore.registerEntityType('XlsxTemplateType', {
    _id: { type: 'Edm.String', key: true },
    'shortid': { type: 'Edm.String' },
    'name': { type: 'Edm.String', publicKey: 'true' },
    'contentRaw': { type: 'Edm.Binary', document: { extension: 'xlsx' } },
    'content': { type: 'Edm.String', document: { extension: 'txt' } }
  })

  reporter.documentStore.registerEntitySet('xlsxTemplates', {
    entityType: 'jsreport.XlsxTemplateType',
    humanReadableKey: 'shortid',
    splitIntoDirectories: true
  })

  reporter.documentStore.registerComplexType('XlsxTemplateRefType', {
    'shortid': { type: 'Edm.String' }
  })

  reporter.initializeListeners.add('xlsxTemplates', () => {
    if (!reporter.documentStore.model.entityTypes['TemplateType']) {
      throw new Error('xlsx recipe depends on jsreport-templates ')
    }

    reporter.documentStore.model.entityTypes['TemplateType'].xlsxTemplate = { type: 'Collection(jsreport.XlsxTemplateRefType)' }

    reporter.documentStore.collection('xlsxTemplates').beforeInsertListeners.add('xlsxTemplates', function (doc) {
      doc.shortid = doc.shortid || shortid.generate()
      return serialize(doc.contentRaw, reporter.options.tempDirectory).then((serialized) => (doc.content = serialized))
    })

    reporter.documentStore.collection('xlsxTemplates').beforeUpdateListeners.add('xlsxTemplates', function (query, update, req) {
      if (update.$set && update.$set.contentRaw) {
        return serialize(update.$set.contentRaw, reporter.options.tempDirectory).then((serialized) => (update.$set.content = serialized))
      }
    })
  })

  reporter.afterTemplatingEnginesExecutedListeners.add('xlsxTemplates', (req, res) => {
    if (req.template.recipe === 'xlsx') {
      return recipe(req, res)
    }
  })

  reporter.beforeRenderListeners.insert({ after: 'data' }, 'xlsxTemplates', (req) => {
    if (req.template.recipe !== 'xlsx') {
      return
    }

    const findTemplate = () => {
      if (!req.template.xlsxTemplate || !req.template.xlsxTemplate.shortid) {
        if (defaultXlsxTemplate) {
          return Promise.resolve(defaultXlsxTemplate)
        }

        if (reporter.execution) {
          return Promise.resolve(JSON.parse(reporter.execution.resource('defaultXlsxTemplate.json').toString()))
        }

        return FS.readFileAsync(path.join(__dirname, '../static', 'defaultXlsxTemplate.json')).then((content) => JSON.parse(content))
      }

      return reporter.documentStore.collection('xlsxTemplates').find({ shortid: req.template.xlsxTemplate.shortid }, req).then((docs) => {
        if (!docs.length) {
          throw new Error('Unable to find xlsx template with shortid ' + req.template.xlsxTemplate.shortid)
        }

        return JSON.parse(docs[0].content)
      })
    }

    return findTemplate().then((t) => {
      req.data = req.data || {}
      req.data.$xlsxTemplate = t
      req.data.$xlsxModuleDirname = path.join(__dirname, '../')
      req.data.$tempDirectory = reporter.options.tempDirectory
      req.data.$addBufferSize = definition.options.addBufferSize || 50000000
      req.data.$escapeAmp = definition.options.escapeAmp
      req.data.$numberOfParsedAddIterations = definition.options.numberOfParsedAddIterations == null ? 50 : definition.options.numberOfParsedAddIterations

      return (reporter.execution ? Promise.resolve(reporter.execution.resource('helpers.js')) : FS.readFileAsync(path.join(__dirname, '../', 'static', 'helpers.js'), 'utf8')).then(
        (content) => {
          if (req.template.helpers && typeof req.template.helpers === 'object') {
            // this is the case when the jsreport is used with in-process strategy
            // and additinal helpers are passed as object
            // in this case we need to merge in xlsx helpers
            req.template.helpers.require = require
            req.template.helpers.fsproxy = require(path.join(__dirname, 'fsproxy.js'))
            return vm.runInNewContext(content, req.template.helpers)
          }

          req.template.helpers = content + '\n' + (req.template.helpers || '')
        })
    })
  })
}
