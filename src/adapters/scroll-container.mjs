export async function moveMouseIntoBox(page, box, {
  yOffset = 0.5,
  xOffset = 0.5,
  logPrefix = '[scroll]',
} = {}) {
  if (!box) return { ok: false, reason: 'missing_box' };

  const x = box.x + box.width * xOffset;
  const y = box.y + box.height * yOffset;

  console.error(`${logPrefix} 鼠标移动到容器内部 x=${x.toFixed(0)}, y=${y.toFixed(0)}`);

  await page.mouse.move(x, y, { steps: 5 });
  await page.waitForTimeout(100);

  return { ok: true, x, y };
}

export async function wheelInBox(page, box, {
  deltaY = 600,
  waitMs = 1200,
  logPrefix = '[scroll]',
} = {}) {
  const moved = await moveMouseIntoBox(page, box, { logPrefix });
  if (!moved.ok) return moved;

  console.error(`${logPrefix} wheel 滚动容器 delta=${deltaY}`);
  await page.mouse.wheel(0, deltaY);
  await page.waitForTimeout(waitMs);

  return { ok: true, scrolled: true, deltaY };
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
  deltaY = 600,
  waitMs = 1200,
  minWidth = 250,
  minHeight = 250,
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
    waitMs,
    logPrefix,
  });
}
