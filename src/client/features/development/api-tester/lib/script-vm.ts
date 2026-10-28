import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core'
import baseVariant from '@jitl/quickjs-wasmfile-release-sync'
import wasmAsset from '@jitl/quickjs-wasmfile-release-sync/wasm?url'
import type { KeyValue, ScriptContext, TestResult } from '@shared/development/api-tester/types'

const PRELUDE = `(function () {
  const ctx = JSON.parse(__apiTesterContext);
  const headers = ctx.request.headers.map(function (entry) { return Object.assign({}, entry); });
  const params = ctx.request.params.map(function (entry) { return Object.assign({}, entry); });
  const env = Object.assign({}, ctx.environment);
  const vars = Object.assign({}, ctx.variables);
  const tests = [];
  const mk = function (key, value) {
    return { id: Math.random().toString(36).slice(2, 12), key: key, value: value, enabled: true };
  };
  const find = function (list, key) {
    const needle = String(key).toLowerCase();
    for (let index = 0; index < list.length; index += 1) {
      if (String(list[index].key).toLowerCase() === needle) return index;
    }
    return -1;
  };
  const headerApi = {
    add: function (entry) { headers.push(mk(entry.key, entry.value)); },
    upsert: function (entry) {
      const index = find(headers, entry.key);
      if (index >= 0) headers[index] = Object.assign({}, headers[index], { key: entry.key, value: entry.value, enabled: true });
      else headers.push(mk(entry.key, entry.value));
    },
    remove: function (key) { const index = find(headers, key); if (index >= 0) headers.splice(index, 1); },
    get: function (key) { const index = find(headers, key); return index >= 0 ? headers[index].value : ''; }
  };
  const paramApi = {
    add: function (entry) { params.push(mk(entry.key, entry.value)); },
    upsert: function (entry) {
      const index = find(params, entry.key);
      if (index >= 0) params[index] = Object.assign({}, params[index], { key: entry.key, value: entry.value, enabled: true });
      else params.push(mk(entry.key, entry.value));
    },
    remove: function (key) { const index = find(params, key); if (index >= 0) params.splice(index, 1); },
    get: function (key) { const index = find(params, key); return index >= 0 ? params[index].value : ''; }
  };
  let parsed;
  let parsedReady = false;
  const response = ctx.response ? {
    status: ctx.response.status,
    statusText: ctx.response.statusText,
    code: ctx.response.status,
    headers: ctx.response.headers,
    body: ctx.response.body,
    durationMs: ctx.response.durationMs,
    sizeBytes: ctx.response.sizeBytes,
    responseTime: ctx.response.durationMs,
    json: function () {
      if (!parsedReady) { parsed = JSON.parse(ctx.response.body); parsedReady = true; }
      return parsed;
    },
    text: function () { return ctx.response.body; }
  } : undefined;
  const expect = function (actual) {
    const self = {
      to: {
        equal: function (expected) {
          if (actual !== expected) throw new Error('Expected ' + JSON.stringify(actual) + ' to equal ' + JSON.stringify(expected));
          return self;
        },
        eql: function (expected) {
          if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Expected ' + JSON.stringify(actual) + ' to deeply equal ' + JSON.stringify(expected));
          return self;
        },
        include: function (value) {
          if (typeof actual === 'string') {
            if (actual.indexOf(String(value)) < 0) throw new Error('Expected the text to include ' + value);
          } else if (Array.isArray(actual)) {
            if (actual.indexOf(value) < 0) throw new Error('Expected the array to include ' + JSON.stringify(value));
          } else {
            throw new Error('include only supports strings and arrays');
          }
          return self;
        },
        have: {
          property: function (key, value) {
            if (actual === null || typeof actual !== 'object') throw new Error('Expected an object to inspect');
            if (!(key in actual)) throw new Error('Expected property ' + key);
            if (value !== undefined && actual[key] !== value) throw new Error('Expected ' + key + ' to equal ' + JSON.stringify(value));
            return expect(actual[key]);
          }
        },
        be: {
          ok: function () { if (!actual) throw new Error('Expected a truthy value, got ' + JSON.stringify(actual)); return self; },
          an: function (type) {
            const actualType = Array.isArray(actual) ? 'array' : typeof actual;
            if (actualType !== type) throw new Error('Expected type ' + type + ', got ' + actualType);
            return self;
          },
          above: function (value) { if (typeof actual !== 'number' || actual <= value) throw new Error('Expected a number above ' + value); return self; },
          below: function (value) { if (typeof actual !== 'number' || actual >= value) throw new Error('Expected a number below ' + value); return self; }
        }
      },
      ok: function () { if (!actual) throw new Error('Expected a truthy value, got ' + JSON.stringify(actual)); return self; }
    };
    return self;
  };
  const pm = {
    environment: {
      set: function (key, value) { env[String(key)] = String(value); },
      get: function (key) { return env[String(key)] === undefined ? '' : env[String(key)]; },
      unset: function (key) { delete env[String(key)]; }
    },
    variables: {
      set: function (key, value) { vars[String(key)] = String(value); },
      get: function (key) { return vars[String(key)] !== undefined ? vars[String(key)] : (env[String(key)] === undefined ? '' : env[String(key)]); },
      unset: function (key) { delete vars[String(key)]; }
    },
    request: { method: ctx.request.method, url: ctx.request.url, body: ctx.request.body || '', headers: headerApi, params: paramApi },
    response: response,
    dynamic: ctx.dynamic,
    test: function (name, fn) {
      try { fn(); tests.push({ name: String(name), passed: true }); }
      catch (error) { tests.push({ name: String(name), passed: false, error: String(error && error.message ? error.message : error) }); }
    },
    expect: expect
  };
  globalThis.pm = pm;
  globalThis.__apiTesterCollect = function () {
    return { headers: headers, params: params, variables: vars, env: env, tests: tests };
  };
})();`

export interface ScriptVmResult {
  headers?: KeyValue[]
  params?: KeyValue[]
  variables: Record<string, string>
  env: Record<string, string>
  tests: TestResult[]
  error?: string
}

export interface ScriptVmOptions {
  script: string
  mode: 'pre' | 'tests'
  context: ScriptContext
  deadlineMs?: number
}

function buildVariant() {
  const asset = wasmAsset as unknown
  if (asset instanceof WebAssembly.Module) return newVariant(baseVariant, { wasmModule: asset })
  if (typeof asset === 'string' && asset) return newVariant(baseVariant, { wasmLocation: asset })
  return baseVariant
}

let engine: Promise<QuickJSWASMModule> | null = null

function quickjs(): Promise<QuickJSWASMModule> {
  if (!engine) {
    engine = newQuickJSWASMModuleFromVariant(buildVariant())
    engine.catch(() => {
      engine = null
    })
  }
  return engine
}

export async function executeScript(options: ScriptVmOptions): Promise<ScriptVmResult> {
  const deadline = options.deadlineMs ?? 2_000
  const interpreter = await quickjs()
  const runtime = interpreter.newRuntime()
  const context = runtime.newContext()
  runtime.setMemoryLimit(16 * 1024 * 1024)
  runtime.setMaxStackSize(512 * 1024)
  const deadlineAt = Date.now() + deadline
  runtime.setInterruptHandler(() => Date.now() > deadlineAt)
  let errorMessage = ''
  try {
    const contextHandle = context.newString(JSON.stringify(options.context))
    context.setProp(context.global, '__apiTesterContext', contextHandle)
    contextHandle.dispose()
    const prelude = context.evalCode(PRELUDE, 'prelude.js')
    if (prelude.error) {
      errorMessage = String((context.dump(prelude.error) as { message?: unknown } | undefined)?.message ?? 'sandbox prelude failed')
      prelude.error.dispose()
      return { variables: {}, env: {}, tests: [], error: errorMessage }
    }
    prelude.value.dispose()
    runtime.setInterruptHandler(() => Date.now() > deadlineAt)
    const program = context.evalCode(`(function (pm) { "use strict";\n${options.script}\n})(pm);`, 'request-script.js')
    if ((program as { error?: unknown }).error) {
      const handle = (program as { error: Parameters<typeof context.dump>[0] }).error
      const dumped = context.dump(handle) as { name?: unknown; message?: unknown } | undefined
      errorMessage = `${dumped?.name ? `${String(dumped.name)}: ` : ''}${String(dumped?.message ?? 'script failed')}`
      handle.dispose()
    } else {
      ;(program as { value: { dispose: () => void } }).value.dispose()
    }
    runtime.setInterruptHandler(() => Date.now() > deadlineAt)
    const collected = context.evalCode('JSON.stringify(__apiTesterCollect())', 'collect.js')
    if (collected.error) {
      const dumped = context.dump(collected.error) as { message?: unknown } | undefined
      collected.error.dispose()
      return { variables: {}, env: {}, tests: [], error: errorMessage || String(dumped?.message ?? 'script result could not be read') }
    }
    const text = context.getString(collected.value)
    collected.value.dispose()
    const parsed = JSON.parse(text) as {
      headers?: KeyValue[]
      params?: KeyValue[]
      variables?: Record<string, string>
      env?: Record<string, string>
      tests?: TestResult[]
    }
    return {
      headers: parsed.headers,
      params: parsed.params,
      variables: parsed.variables ?? {},
      env: parsed.env ?? {},
      tests: parsed.tests ?? [],
      error: errorMessage || undefined,
    }
  } catch (error) {
    return {
      variables: {},
      env: {},
      tests: [],
      error: `${error instanceof Error ? error.name : 'Error'}: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    context.dispose()
    runtime.dispose()
  }
}
