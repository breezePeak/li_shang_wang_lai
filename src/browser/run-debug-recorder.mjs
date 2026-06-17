import fs from 'fs';
import path from 'path';
import { ensureDir, writeJSON } from '../utils/filesystem.mjs';
import {
  captureDomFragment,
  captureFullScreenshot,
  capturePageDiagnostics,
} from './page-diagnostics.mjs';

const PAGE_INSTRUMENTED = Symbol('lswl.page.debug.instrumented');
const LOCATOR_PROXY = Symbol('lswl.locator.debug.proxy');
const INTERNAL_CAPTURE = Symbol('lswl.debug.internal.capture');

function sanitizeSegment(value = '') {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'step';
}

function summarizeArg(value, depth = 0) {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'function') {
    return `[Function ${value.name || 'anonymous'}]`;
  }
  if (Array.isArray(value)) {
    if (depth >= 1) return `[Array(${value.length})]`;
    return value.slice(0, 8).map(item => summarizeArg(item, depth + 1));
  }
  if (typeof value === 'object') {
    if (typeof value.toString === 'function') {
      const stringified = String(value);
      if (stringified && stringified !== '[object Object]' && !stringified.startsWith('[object ')) {
        return stringified.length > 160 ? `${stringified.slice(0, 157)}...` : stringified;
      }
    }
    if (depth >= 1) return '[Object]';
    const entries = Object.entries(value).slice(0, 12);
    return Object.fromEntries(entries.map(([key, item]) => [key, summarizeArg(item, depth + 1)]));
  }
  return String(value);
}

function timestampLine(level, args) {
  const ts = new Date().toISOString();
  const text = args.map(arg => {
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }).join(' ');
  return `[${ts}] [${level}] ${text}\n`;
}

async function safePageInfo(page) {
  try {
    return await capturePageDiagnostics(page);
  } catch {
    return { url: '', title: '', timestamp: new Date().toISOString() };
  }
}

function wrapLocator(recorder, page, locator, label = 'locator') {
  if (!locator || typeof locator !== 'object') return locator;
  if (locator[LOCATOR_PROXY]) return locator;

  const actionMethods = new Set([
    'click', 'dblclick', 'fill', 'clear', 'press', 'type', 'hover', 'focus',
    'check', 'uncheck', 'selectOption', 'setInputFiles', 'tap', 'dispatchEvent',
    'scrollIntoViewIfNeeded', 'waitFor', 'evaluate',
  ]);
  const locatorFactoryMethods = new Set([
    'locator', 'getByText', 'getByRole', 'getByLabel', 'getByPlaceholder',
    'getByTestId', 'filter', 'first', 'last', 'nth', 'or', 'and',
  ]);

  const proxy = new Proxy(locator, {
    get(target, prop, receiver) {
      if (prop === LOCATOR_PROXY) return true;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      if (locatorFactoryMethods.has(prop)) {
        return (...args) => {
          const nextLocator = value.apply(target, args);
          const nextLabel = `${label}.${String(prop)}(${args.map(arg => sanitizeSegment(JSON.stringify(summarizeArg(arg)) || '')).join(',')})`;
          return wrapLocator(recorder, page, nextLocator, nextLabel);
        };
      }

      if (actionMethods.has(prop)) {
        return async (...args) => {
          const step = `${label}.${String(prop)}`;
          try {
            const result = await value.apply(target, args);
            await recorder.capture(page, step, {
              scope: 'locator',
              status: 'ok',
              args: args.map(arg => summarizeArg(arg)),
            });
            return result;
          } catch (error) {
            await recorder.capture(page, step, {
              scope: 'locator',
              status: 'error',
              args: args.map(arg => summarizeArg(arg)),
              error: error?.message || String(error),
            });
            throw error;
          }
        };
      }

      return value.bind(target);
    },
  });

  return proxy;
}

export function createRunDebugRecorder(run, { command = run?.command || 'unknown' } = {}) {
  const enabled = Boolean(run?.options?.debug);
  const debugDir = path.join(run?.outputDir || process.cwd(), 'debug');
  const stepsDir = path.join(debugDir, 'steps');
  const logsDir = path.join(debugDir, 'logs');
  const logFile = path.join(logsDir, 'execution.log');
  let stepIndex = 0;
  let captureQueue = Promise.resolve();
  let consolePatched = false;
  let originals = null;

  function appendLog(level, args) {
    if (!enabled) return;
    ensureDir(logsDir);
    fs.appendFileSync(logFile, timestampLine(level, args), 'utf8');
  }

  async function capture(page, step, extra = {}) {
    if (!enabled || !page || page[INTERNAL_CAPTURE]) {
      return null;
    }

    const currentIndex = ++stepIndex;
    const dirName = `${String(currentIndex).padStart(5, '0')}_${sanitizeSegment(step)}`;
    const stepDir = path.join(stepsDir, dirName);
    const capturedAt = new Date().toISOString();

    captureQueue = captureQueue.then(async () => {
      ensureDir(stepDir);
      page[INTERNAL_CAPTURE] = true;
      try {
        const pageInfo = await safePageInfo(page);
        writeJSON(path.join(stepDir, 'step.json'), {
          index: currentIndex,
          command,
          step,
          capturedAt,
          ...extra,
          pageInfo,
        });

        const html = await captureDomFragment(page);
        fs.writeFileSync(path.join(stepDir, 'dom.html'), html, 'utf8');
        await captureFullScreenshot(page, path.join(stepDir, 'screenshot.png'));
      } catch (error) {
        writeJSON(path.join(stepDir, 'step.json'), {
          index: currentIndex,
          command,
          step,
          capturedAt,
          ...extra,
          captureError: error?.message || String(error),
        });
      } finally {
        page[INTERNAL_CAPTURE] = false;
      }
    }).catch(() => {});

    await captureQueue;
    return stepDir;
  }

  function instrumentPage(page, { label = 'page' } = {}) {
    if (!enabled || !page || page[PAGE_INSTRUMENTED]) return page;
    ensureDir(run.outputDir);
    ensureDir(debugDir);
    ensureDir(stepsDir);
    ensureDir(logsDir);

    const pageMethods = new Set([
      'goto', 'goBack', 'goForward', 'reload', 'click', 'dblclick', 'fill',
      'press', 'type', 'hover', 'focus', 'check', 'uncheck', 'setInputFiles',
      'waitForTimeout', 'waitForSelector', 'evaluate',
    ]);
    const locatorFactories = new Set([
      'locator', 'getByText', 'getByRole', 'getByLabel', 'getByPlaceholder', 'getByTestId',
    ]);

    for (const methodName of pageMethods) {
      if (typeof page[methodName] !== 'function') continue;
      const original = page[methodName].bind(page);
      page[methodName] = async (...args) => {
        if (page[INTERNAL_CAPTURE]) {
          return original(...args);
        }
        const step = `${label}.${methodName}`;
        try {
          const result = await original(...args);
          await capture(page, step, {
            scope: 'page',
            status: 'ok',
            args: args.map(arg => summarizeArg(arg)),
          });
          return result;
        } catch (error) {
          await capture(page, step, {
            scope: 'page',
            status: 'error',
            args: args.map(arg => summarizeArg(arg)),
            error: error?.message || String(error),
          });
          throw error;
        }
      };
    }

    for (const factoryName of locatorFactories) {
      if (typeof page[factoryName] !== 'function') continue;
      const original = page[factoryName].bind(page);
      page[factoryName] = (...args) => {
        const locator = original(...args);
        const locatorLabel = `${label}.${factoryName}(${args.map(arg => sanitizeSegment(JSON.stringify(summarizeArg(arg)) || '')).join(',')})`;
        return wrapLocator(recorder, page, locator, locatorLabel);
      };
    }

    if (page.keyboard) {
      for (const methodName of ['press', 'type', 'down', 'up']) {
        if (typeof page.keyboard[methodName] !== 'function') continue;
        const original = page.keyboard[methodName].bind(page.keyboard);
        page.keyboard[methodName] = async (...args) => {
          if (page[INTERNAL_CAPTURE]) {
            return original(...args);
          }
          const step = `${label}.keyboard.${methodName}`;
          try {
            const result = await original(...args);
            await capture(page, step, {
              scope: 'keyboard',
              status: 'ok',
              args: args.map(arg => summarizeArg(arg)),
            });
            return result;
          } catch (error) {
            await capture(page, step, {
              scope: 'keyboard',
              status: 'error',
              args: args.map(arg => summarizeArg(arg)),
              error: error?.message || String(error),
            });
            throw error;
          }
        };
      }
    }

    if (page.mouse) {
      for (const methodName of ['click', 'dblclick', 'move', 'down', 'up', 'wheel']) {
        if (typeof page.mouse[methodName] !== 'function') continue;
        const original = page.mouse[methodName].bind(page.mouse);
        page.mouse[methodName] = async (...args) => {
          if (page[INTERNAL_CAPTURE]) {
            return original(...args);
          }
          const step = `${label}.mouse.${methodName}`;
          try {
            const result = await original(...args);
            await capture(page, step, {
              scope: 'mouse',
              status: 'ok',
              args: args.map(arg => summarizeArg(arg)),
            });
            return result;
          } catch (error) {
            await capture(page, step, {
              scope: 'mouse',
              status: 'error',
              args: args.map(arg => summarizeArg(arg)),
              error: error?.message || String(error),
            });
            throw error;
          }
        };
      }
    }

    page[PAGE_INSTRUMENTED] = true;
    appendLog('INFO', [`[debug] page instrumented label=${label}`]);
    return page;
  }

  function startConsoleCapture() {
    if (!enabled || consolePatched) return;
    ensureDir(logsDir);
    originals = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    for (const level of Object.keys(originals)) {
      console[level] = (...args) => {
        appendLog(level.toUpperCase(), args);
        originals[level](...args);
      };
    }
    consolePatched = true;
    appendLog('INFO', [`[debug] console capture enabled for ${command}`]);
  }

  function stopConsoleCapture() {
    if (!consolePatched || !originals) return;
    appendLog('INFO', [`[debug] console capture disabled for ${command}`]);
    console.log = originals.log;
    console.info = originals.info;
    console.warn = originals.warn;
    console.error = originals.error;
    console.debug = originals.debug;
    consolePatched = false;
    originals = null;
  }

  const recorder = {
    enabled,
    debugDir,
    stepsDir,
    logFile,
    startConsoleCapture,
    stopConsoleCapture,
    instrumentPage,
    capture,
  };

  return recorder;
}
