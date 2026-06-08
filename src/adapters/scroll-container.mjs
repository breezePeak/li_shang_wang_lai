import { loadConfig } from '../config/user-config.mjs';

function toFiniteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function normalizeScrollRange(range, fallbackMin = 0, fallbackMax = 0) {
  if (Array.isArray(range) && range.length >= 2) {
    const a = toFiniteNumber(range[0], fallbackMin);
    const b = toFiniteNumber(range[1], fallbackMax);
    return a <= b ? [a, b] : [b, a];
  }
  return [fallbackMin, fallbackMax];
}

function randomInRange(min, max) {
  if (max <= min) return min;
  return min + Math.random() * (max - min);
}

function getScrollConfig() {
  return loadConfig().scroll || {};
}

export function buildWheelScrollPlan(options = {}, wheelConfig = {}) {
  const {
    deltaY = null,
    deltaYRandomRange = null,
    waitMs = null,
  } = options;
  const hasExplicitDeltaY = deltaY !== null && deltaY !== undefined;

  const baseDeltaY = Math.round(toFiniteNumber(
    deltaY ?? wheelConfig.deltaY ?? wheelConfig.defaultDeltaY,
    600
  ));
  const [jitterMin, jitterMax] = normalizeScrollRange(
    deltaYRandomRange ?? (hasExplicitDeltaY ? [0, 0] : wheelConfig.deltaYRandomRange),
    0,
    0
  );
  const jitter = Math.round(randomInRange(jitterMin, jitterMax));
  const resolvedDeltaY = Math.max(1, baseDeltaY + jitter);
  const resolvedWaitMs = Math.max(0, Math.round(toFiniteNumber(waitMs ?? wheelConfig.waitMs, 1200)));

  return {
    deltaY: resolvedDeltaY,
    waitMs: resolvedWaitMs,
    jitter,
    baseDeltaY,
  };
}

export async function moveMouseIntoBox(page, box, {
  yOffset = null,
  xOffset = null,
  steps = null,
  waitMs = null,
  logPrefix = '[scroll]',
} = {}) {
  if (!box) return { ok: false, reason: 'missing_box' };

  const mouseMoveConfig = getScrollConfig().mouseMove || {};
  const resolvedXOffset = toFiniteNumber(xOffset ?? mouseMoveConfig.xOffset, 0.5);
  const resolvedYOffset = toFiniteNumber(yOffset ?? mouseMoveConfig.yOffset, 0.5);
  const resolvedSteps = Math.max(1, Math.round(toFiniteNumber(steps ?? mouseMoveConfig.steps, 5)));
  const resolvedWaitMs = Math.max(0, Math.round(toFiniteNumber(waitMs ?? mouseMoveConfig.waitMs, 100)));

  const x = box.x + box.width * resolvedXOffset;
  const y = box.y + box.height * resolvedYOffset;

  console.error(`${logPrefix} 鼠标移动到容器内部 x=${x.toFixed(0)}, y=${y.toFixed(0)}`);

  await page.mouse.move(x, y, { steps: resolvedSteps });
  await page.waitForTimeout(resolvedWaitMs);

  return { ok: true, x, y };
}

export async function wheelInBox(page, box, {
  deltaY = null,
  deltaYRandomRange = null,
  waitMs = null,
  profile = '',
  domScrollFallback = false,
  logPrefix = '[scroll]',
} = {}) {
  const moved = await moveMouseIntoBox(page, box, { logPrefix });
  if (!moved.ok) return moved;

  const scrollConfig = getScrollConfig();
  const wheelConfig = {
    ...(scrollConfig.wheel || {}),
    ...(profile && scrollConfig[profile] ? scrollConfig[profile] : {}),
  };
  const plan = buildWheelScrollPlan({ deltaY, deltaYRandomRange, waitMs }, wheelConfig);

  console.error(`${logPrefix} wheel 滚动容器 delta=${plan.deltaY}${plan.jitter ? ` jitter=${plan.jitter}` : ''}`);
  await page.mouse.wheel(0, plan.deltaY);
  if (domScrollFallback) {
    const domScrolled = await page.evaluate(({ x, y, deltaY: scrollDelta }) => {
      const el = document.elementFromPoint(x, y);
      let current = el;
      while (current && current !== document.body) {
        if (current.scrollHeight > current.clientHeight + 20) {
          const before = current.scrollTop;
          current.scrollTop = before + scrollDelta;
          return { ok: true, before, after: current.scrollTop };
        }
        current = current.parentElement;
      }
      return { ok: false };
    }, { x: moved.x, y: moved.y, deltaY: plan.deltaY }).catch(() => ({ ok: false })) || { ok: false };
    if (domScrolled.ok) {
      console.error(`${logPrefix} DOM scrollTop ${domScrolled.before}->${domScrolled.after}`);
    }
  }
  await page.waitForTimeout(plan.waitMs);

  return { ok: true, scrolled: true, deltaY: plan.deltaY, jitter: plan.jitter };
}

export async function findScrollableContainerBox(page, {
  selectors = [],
  requiredText = [],
  minWidth = 250,
  minHeight = 250,
  logPrefix = '[scroll]',
} = {}) {
  const result = await page.evaluate(({ selectors, requiredText, minWidth, minHeight }) => {
    function visible(el) {
      const r = el.getBoundingClientRect();
      if (r.width < minWidth || r.height < minHeight) return false;
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY || style.overflow;
      const canScroll =
        overflowY === 'auto' ||
        overflowY === 'scroll' ||
        el.scrollHeight > el.clientHeight + 20;
      return canScroll;
    }

    const candidates = [];

    for (const selector of selectors || []) {
      for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        const text = (el.innerText || '').trim();

        if (requiredText && requiredText.length > 0) {
          let ok = false;
          for (const needle of requiredText) {
            if (text.includes(needle)) {
              ok = true;
              break;
            }
          }
          if (!ok) continue;
        }

        const r = el.getBoundingClientRect();
        candidates.push({
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          selector,
          textPreview: text.slice(0, 120),
        });
      }
    }

    if (candidates.length === 0) {
      return { ok: false, reason: 'container_not_found' };
    }

    candidates.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return { ok: true, box: candidates[0], count: candidates.length };
  }, { selectors, requiredText, minWidth, minHeight });

  if (!result.ok) {
    console.error(`${logPrefix} 未找到可滚动容器 reason=${result.reason}`);
    return result;
  }

  console.error(
    `${logPrefix} 找到滚动容器 selector=${result.box.selector} x=${result.box.x.toFixed(0)} y=${result.box.y.toFixed(0)} w=${result.box.width.toFixed(0)} h=${result.box.height.toFixed(0)} candidates=${result.count}`
  );

  return result;
}

export async function scrollContainerByWheel(page, {
  box = null,
  selectors = [],
  requiredText = [],
  deltaY = null,
  deltaYRandomRange = null,
  waitMs = null,
  minWidth = 250,
  minHeight = 250,
  profile = '',
  domScrollFallback = false,
  logPrefix = '[scroll]',
} = {}) {
  let targetBox = box;

  if (!targetBox) {
    const found = await findScrollableContainerBox(page, {
      selectors,
      requiredText,
      minWidth,
      minHeight,
      logPrefix,
    });
    if (!found.ok) return found;
    targetBox = found.box;
  }

  return wheelInBox(page, targetBox, {
    deltaY,
    deltaYRandomRange,
    waitMs,
    profile,
    domScrollFallback,
    logPrefix,
  });
}
