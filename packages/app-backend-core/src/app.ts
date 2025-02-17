import {
  AppRecord,
  SimpleAppRecord,
  AppRecordOptions,
  BackendContext,
  DevtoolsBackend,
} from '@vue-devtools/app-backend-api'
import { BridgeEvents, SharedData } from '@vue-devtools/shared-utils'
import { App } from '@vue/devtools-api'
import slug from 'speakingurl'
import { JobQueue } from './util/queue'
import { scan } from './legacy/scan'
import { addBuiltinLayers, removeLayersForApp } from './timeline'
import { getBackend, availableBackends } from './backend'

const jobs = new JobQueue()

let recordId = 0

type AppRecordResolver = (record: AppRecord) => void | Promise<void>
const appRecordPromises = new Map<App, AppRecordResolver[]>()

export async function registerApp (options: AppRecordOptions, ctx: BackendContext) {
  return jobs.queue(() => registerAppJob(options, ctx))
}

async function registerAppJob (options: AppRecordOptions, ctx: BackendContext) {
  // Dedupe
  if (ctx.appRecords.find(a => a.options === options)) {
    return
  }

  // Find correct backend
  const baseFrameworkVersion = parseInt(options.version.substr(0, options.version.indexOf('.')))
  for (let i = 0; i < availableBackends.length; i++) {
    const backendOptions = availableBackends[i]
    if (backendOptions.frameworkVersion === baseFrameworkVersion) {
      // Enable backend if it's not enabled
      const backend = getBackend(backendOptions, ctx)

      await createAppRecord(options, backend, ctx)

      break
    }
  }
}

async function createAppRecord (options: AppRecordOptions, backend: DevtoolsBackend, ctx: BackendContext) {
  const rootInstance = await backend.api.getAppRootInstance(options.app)
  if (rootInstance) {
    recordId++
    const name = await backend.api.getAppRecordName(options.app, recordId.toString())
    const id = getAppRecordId(options.app, slug(name))

    const [el]: HTMLElement[] = await backend.api.getComponentRootElements(rootInstance)

    const record: AppRecord = {
      id,
      name,
      options,
      backend,
      lastInspectedComponentId: null,
      instanceMap: new Map(),
      rootInstance,
      perfGroupIds: new Map(),
      iframe: document !== el.ownerDocument ? el.ownerDocument.location.pathname : null,
      meta: options.meta ?? {},
    }
    options.app.__VUE_DEVTOOLS_APP_RECORD__ = record
    const rootId = `${record.id}:root`
    record.instanceMap.set(rootId, record.rootInstance)
    record.rootInstance.__VUE_DEVTOOLS_UID__ = rootId

    // Timeline
    addBuiltinLayers(record, ctx)

    ctx.appRecords.push(record)

    if (backend.options.setupApp) {
      backend.options.setupApp(backend.api, record)
    }

    await backend.api.registerApplication(options.app)

    ctx.bridge.send(BridgeEvents.TO_FRONT_APP_ADD, {
      appRecord: mapAppRecord(record),
    })

    if (appRecordPromises.has(options.app)) {
      for (const r of appRecordPromises.get(options.app)) {
        await r(record)
      }
    }

    // Auto select first app
    if (ctx.currentAppRecord == null && !(await record.backend.api.getComponentDevtoolsOptions(record.rootInstance)).hide) {
      await selectApp(record, ctx)
    }
  } else {
    console.warn('[Vue devtools] No root instance found for app, it might have been unmounted', options.app)
  }
}

export async function selectApp (record: AppRecord, ctx: BackendContext) {
  ctx.currentAppRecord = record
  ctx.currentInspectedComponentId = record.lastInspectedComponentId
  ctx.bridge.send(BridgeEvents.TO_FRONT_APP_SELECTED, {
    id: record.id,
    lastInspectedComponentId: record.lastInspectedComponentId,
  })
}

export function mapAppRecord (record: AppRecord): SimpleAppRecord {
  return {
    id: record.id,
    name: record.name,
    version: record.options.version,
    iframe: record.iframe,
  }
}

const appIds = new Set()

export function getAppRecordId (app, defaultId?: string): string {
  if (app.__VUE_DEVTOOLS_APP_RECORD_ID__ != null) {
    return app.__VUE_DEVTOOLS_APP_RECORD_ID__
  }
  let id = defaultId ?? (recordId++).toString()

  if (defaultId && appIds.has(id)) {
    let count = 1
    while (appIds.has(`${defaultId}:${count}`)) {
      count++
    }
    id = `${defaultId}_${count}`
  }

  appIds.add(id)

  app.__VUE_DEVTOOLS_APP_RECORD_ID__ = id
  return id
}

export async function getAppRecord (app: any, ctx: BackendContext): Promise<AppRecord> {
  const record = ctx.appRecords.find(ar => ar.options.app === app)
  if (record) {
    return record
  }
  return new Promise((resolve, reject) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      reject(new Error(`Timed out getting app record for app ${app}`))
    }, 2000)
    let resolvers = appRecordPromises.get(app)
    if (!resolvers) {
      resolvers = []
      appRecordPromises.set(app, resolvers)
    }
    resolvers.push((record) => {
      if (!timedOut) {
        clearTimeout(timer)
        resolve(record)
      }
    })
  })
}

export function waitForAppsRegistration () {
  return jobs.queue(async () => { /* NOOP */ })
}

export async function sendApps (ctx: BackendContext) {
  const appRecords = []

  for (const appRecord of ctx.appRecords) {
    if (!(await appRecord.backend.api.getComponentDevtoolsOptions(appRecord.rootInstance)).hide) {
      appRecords.push(appRecord)
    }
  }

  ctx.bridge.send(BridgeEvents.TO_FRONT_APP_LIST, {
    apps: appRecords.map(mapAppRecord),
  })
}

export async function removeApp (app: App, ctx: BackendContext) {
  try {
    const appRecord = await getAppRecord(app, ctx)
    if (appRecord) {
      appIds.delete(appRecord.id)
      const index = ctx.appRecords.indexOf(appRecord)
      if (index !== -1) ctx.appRecords.splice(index, 1)
      removeLayersForApp(app, ctx)
      ctx.bridge.send(BridgeEvents.TO_FRONT_APP_REMOVE, { id: appRecord.id })
    }
  } catch (e) {
    if (SharedData.debugInfo) {
      console.error(e)
    }
  }
}

// eslint-disable-next-line camelcase
export async function _legacy_getAndRegisterApps (Vue: any, ctx: BackendContext) {
  const apps = scan()
  apps.forEach(app => {
    registerApp({
      app,
      types: {},
      version: Vue.version,
      meta: {
        Vue,
      },
    }, ctx)
  })
}
