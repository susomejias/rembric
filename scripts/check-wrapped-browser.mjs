import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { URL } from 'node:url';

let url;
try {
  url = new URL(process.argv[2] ?? 'http://localhost:3000/dashboard/wrapped');
} catch (cause) {
  throw new Error('Pass a valid local Wrapped URL', { cause });
}
assert(['localhost', '127.0.0.1'].includes(url.hostname), 'Use a local fixture server');
assert(
  process.env.AGENT_BROWSER_SESSION,
  'Set AGENT_BROWSER_SESSION to an authenticated browser session',
);
const env = {
  ...process.env,
  AGENT_BROWSER_RESTORE: process.env.AGENT_BROWSER_RESTORE ?? process.env.AGENT_BROWSER_SESSION,
};
function browser(...args) {
  try {
    const result = JSON.parse(
      execFileSync(
        'agent-browser',
        ['--restore', env.AGENT_BROWSER_RESTORE, '--restore-save', 'never', ...args, '--json'],
        { env, encoding: 'utf8' },
      ),
    );
    assert(result.success, result.error);
    return result.data;
  } catch (cause) {
    throw new Error(`Browser command failed: ${args[0]}`, { cause });
  }
}
function evaluate(code) {
  return browser('eval', code).result;
}
function wait(ms) {
  browser('wait', String(ms));
}
function screen() {
  return Number(
    evaluate('document.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")'),
  );
}
function button(name) {
  browser('click', `button[aria-label="${name}"]`);
}
function tap(side, hold = 0) {
  const { x, y } = evaluate(
    `(() => { const r = document.querySelector('.wrapped-content').getBoundingClientRect(); return {x:r.${side === 'left' ? 'left + 8' : 'right - 8'}, y:r.top+20}; })()`,
  );
  browser('mouse', 'move', String(x), String(y));
  browser('mouse', 'down');
  if (hold) wait(hold);
  browser('mouse', 'up');
  wait(900);
}

try {
  browser('set', 'media', 'dark');
  browser('set', 'viewport', '390', '844');
  browser('open', url.href);
  browser('wait', '--text', 'Your year.');
  assert.equal(screen(), 1);
  button('Pause story');
  for (const [width, height] of [
    [320, 640],
    [390, 844],
    [440, 956],
    [1470, 812],
    [1280, 720],
    [1440, 1000],
  ]) {
    browser('set', 'viewport', String(width), String(height));
    wait(200);
    const cover = evaluate(`(() => {
      const card = document.querySelector('.wrapped-cover-front');
      const padding = parseFloat(getComputedStyle(card).paddingBottom);
      return {
        padding,
        bottomSpace: card.clientHeight - Math.max(...Array.from(card.children, child => child.offsetTop + child.offsetHeight)),
        separated: card.getBoundingClientRect().bottom <= document.querySelector('.wrapped-intro-totals').getBoundingClientRect().top,
      };
    })()`);
    console.log(`Cover at ${width}px:`, cover);
    assert(
      cover.bottomSpace >= cover.padding - 1,
      `Cover copy must retain bottom padding at ${width}px`,
    );
    assert(cover.separated, `Tilted cover must not overlap totals at ${width}px`);
    assert.equal(
      evaluate('document.documentElement.scrollHeight > innerHeight'),
      false,
      `Wrapped must not add an outer scrollbar at ${width}px`,
    );
    assert.equal(evaluate('document.documentElement.scrollWidth > innerWidth'), false);
  }
  browser('set', 'viewport', '390', '844');
  evaluate(`document.querySelector('a[aria-label="Close Wrapped"]').focus(); true`);
  browser('press', 'Tab');
  assert(
    evaluate(`(() => {
      const button = document.activeElement;
      const rect = button.getBoundingClientRect();
      return button.textContent.trim() === 'Next screen' && button.matches(':focus-visible') &&
        rect.height >= 44 && rect.width >= 44 && rect.bottom <= innerHeight;
    })()`),
    'Hidden navigation must become a visible, full-size keyboard target',
  );
  browser('press', 'Enter');
  wait(900);
  assert.equal(screen(), 2, 'Focused navigation remains operable');
  browser('press', 'Home');
  evaluate('document.activeElement.blur(); true');
  wait(7500);
  assert.equal(screen(), 1, 'Pause must prevent automatic navigation');
  assert(
    evaluate(
      `getComputedStyle(document.querySelector('nav[aria-label="Story navigation"]')).position === 'absolute'`,
    ),
    'No navigation row consumes content height',
  );
  assert(evaluate('document.querySelector(".wrapped-shell > p").classList.contains("sr-only")'));
  button('Play story');
  browser('wait', '--text', 'Worth remembering.');
  assert.equal(screen(), 2, 'Automatic progression must work');
  wait(1200);
  tap('right');
  assert.equal(screen(), 3, 'Right tap advances');
  assert(
    evaluate(
      `Array.from(document.querySelectorAll('[role=progressbar] > span > span')).slice(0,2).every(e => new DOMMatrix(getComputedStyle(e).transform).a === 1)`,
    ),
    'Tapping completes every previous progress segment',
  );
  wait(1200);
  tap('left');
  assert.equal(screen(), 2, 'Left tap goes back');
  assert(
    evaluate(
      `Array.from(document.querySelectorAll('[role=progressbar] > span > span')).slice(2).every(e => new DOMMatrix(getComputedStyle(e).transform).a === 0)`,
    ),
    'Back navigation clears every upcoming progress segment',
  );
  tap('right', 7500);
  assert.equal(screen(), 2, 'Holding pauses and releasing a hold does not navigate');
  button('Pause story');
  assert(
    evaluate(
      `(() => { const main=document.querySelector('.wrapped-memory-main').getBoundingClientRect(), bottom=document.querySelector('.wrapped-memory-bottom').getBoundingClientRect(); return bottom.top >= main.bottom; })()`,
    ),
    'Totals must not cut into the tilted card',
  );
  browser('press', 'Home');
  wait(900);
  assert.equal(screen(), 1);
  assert(
    evaluate(
      '!!document.querySelector(".wrapped-edition") && !document.querySelector(".wrapped-orbit")',
    ),
    'Intro uses the overview card direction, not an orbit',
  );
  assert(evaluate('!document.body.innerText.includes("Only your numbers. Nothing private.")'));

  assert.equal(evaluate('document.querySelectorAll(".wrapped-intro-totals > div").length'), 6);
  assert(
    evaluate('document.querySelector(".wrapped-intro-totals").textContent.includes("judgments")'),
  );
  browser('set', 'viewport', '320', '640');
  assert.equal(evaluate('document.documentElement.scrollWidth > innerWidth'), false);
  browser('set', 'viewport', '390', '844');
  for (let i = 0; i < 7; i++) {
    browser('press', 'ArrowRight');
    wait(400);
  }
  assert.equal(screen(), 8);
  const calendar = evaluate(
    `(() => { const year=Number(document.querySelector('#wrapped-year').value); return {months:document.querySelectorAll('.wrapped-calendar-month').length, cells:document.querySelectorAll('.wrapped-calendar-month > span').length, expected:(Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/86400000, active:document.querySelectorAll('.wrapped-calendar-month .bg-primary').length, displayed:Number(document.querySelector('.wrapped-hero .sr-only').textContent.replaceAll(',',''))}; })()`,
  );
  assert.equal(calendar.months, 12);
  assert.equal(calendar.cells, calendar.expected);
  assert.equal(calendar.active, calendar.displayed);

  evaluate(
    `window.__shares = []; Object.defineProperty(navigator, 'canShare', { configurable:true, value:({files}) => files?.[0]?.type === 'image/png' }); Object.defineProperty(navigator, 'share', { configurable:true, value:async payload => { window.__shares.push({payload, activated:navigator.userActivation.isActive}); if(window.__shareFailure) throw new DOMException('test',window.__shareFailure); } }); true`,
  );
  evaluate(
    `window.__canvasText=[]; const fill=CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText=function(text,...args){window.__canvasText.push(text); return fill.call(this,text,...args)}; true`,
  );
  browser('press', 'End');
  browser('wait', '--text', 'Share Wrapped');
  browser('wait', '--fn', `document.querySelector('img[alt^="Exact export preview"]') !== null`);
  for (const format of ['square', 'story']) {
    browser('click', `label:has(input[value="${format}"])`);
    browser(
      'wait',
      '--fn',
      'Array.from(document.querySelectorAll("button")).some(b => b.textContent.includes("Share Wrapped") && !b.disabled)',
    );
    for (const [width, height] of [
      [1470, 812],
      [1280, 720],
      [1440, 1000],
    ]) {
      browser('set', 'viewport', String(width), String(height));
      const layout = evaluate(`(() => {
        const content = document.querySelector('.wrapped-content');
        const image = document.querySelector('img[alt^="Exact export preview"]');
        const button = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Share Wrapped'));
        return {
          outerScroll: document.documentElement.scrollHeight > innerHeight,
          innerScroll: content.scrollHeight > content.clientHeight + 1,
          buttonVisible: button.getBoundingClientRect().bottom <= content.getBoundingClientRect().bottom,
          imageHeight: image.getBoundingClientRect().height,
        };
      })()`);
      console.log(`Share ${format} at ${width}×${height}:`, layout);
      assert(
        !layout.outerScroll && !layout.innerScroll,
        'Desktop sharing must fit without scrolling',
      );
      assert(
        layout.buttonVisible && layout.imageHeight >= 100,
        'Keep share controls and a usable preview visible',
      );
    }
    browser('set', 'viewport', '390', '844');
    browser('find', 'role', 'button', 'click', '--name', 'Share Wrapped');
    const result = evaluate(
      `(async()=>{const s=window.__shares.at(-1), f=s.payload.files[0], blob=await fetch(document.querySelector('img[alt^="Exact export preview"]').src).then(r=>r.blob());const digest=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await b.arrayBuffer()))).join(',');const image=await createImageBitmap(f);return {activated:s.activated,match:await digest(f)===await digest(blob),dimensions:[image.width,image.height],keys:Object.keys(s.payload)}})()`,
    );
    assert(result.activated, 'Share must run within user activation');
    assert(result.match, 'Shared File and preview must contain identical bytes');
    assert.deepEqual(result.dimensions, format === 'square' ? [1080, 1080] : [1080, 1920]);
    assert.deepEqual(result.keys.sort(), ['files', 'title']);
    assert.equal(screen(), 10, 'Format controls must not trigger side navigation');
    assert(
      evaluate('window.__canvasText.includes("entities")'),
      'Entities must appear in the shared card',
    );
    assert(
      evaluate('window.__canvasText.includes("judgments")'),
      'Judgments must appear in the shared card',
    );
    assert(
      evaluate(
        '!window.__canvasText.some(t => /Year to date|All projects|UTC|Retained records|No private content/.test(t))',
      ),
      'The technical caption must not appear in the PNG',
    );
    assert.equal(
      evaluate(
        'getComputedStyle(document.querySelector(".wrapped-share-preview")).backgroundImage',
      ),
      'none',
      'No locally clipped share glow',
    );
  }
  evaluate('window.__shareFailure = "AbortError"');
  browser('find', 'role', 'button', 'click', '--name', 'Share Wrapped');
  assert.equal(
    evaluate('!!document.querySelector("[role=alert]")'),
    false,
    'Cancel is not an error',
  );
  evaluate('window.__shareFailure = "NotAllowedError"');
  browser('find', 'role', 'button', 'click', '--name', 'Share Wrapped');
  browser('wait', '--text', 'Could not open sharing.');
  evaluate('window.__shareFailure = null');
  browser('find', 'role', 'button', 'click', '--name', 'Share Wrapped');
  assert.equal(evaluate('!!document.querySelector("[role=alert]")'), false);
  wait(7500);
  assert.equal(screen(), 10, 'Sharing is the stable last screen');

  browser('open', url.href);
  browser('set', 'media', 'dark', 'reduced-motion');
  evaluate('location.reload(); true');
  browser('wait', '--text', 'Your year.');
  assert(
    evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'),
    'Browser must retain reduced-motion emulation',
  );
  console.log(
    'Reduced motion before wait:',
    evaluate(
      `({reduce:matchMedia('(prefers-reduced-motion: reduce)').matches, paused:document.querySelector('.wrapped-shell')?.dataset.paused, screen:document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow'), ready:document.readyState})`,
    ),
  );
  wait(7500);
  console.log(
    'Reduced motion after wait:',
    evaluate(
      `({reduce:matchMedia('(prefers-reduced-motion: reduce)').matches, paused:document.querySelector('.wrapped-shell')?.dataset.paused, screen:document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')})`,
    ),
  );
  assert.equal(screen(), 1, 'Reduced motion starts paused');
  assert(evaluate(`!!document.querySelector('button[aria-label="Play story"]')`));
  browser('press', 'ArrowRight');
  wait(900);
  assert.equal(screen(), 2, 'Keyboard works with reduced motion');
  browser('set', 'viewport', '1470', '812');
  browser('press', 'Home');
  for (let i = 1; i <= 10; i++) {
    wait(200);
    assert.equal(screen(), i);
    const fit = evaluate(`(() => {
      const content = document.querySelector('.wrapped-content');
      return { outer: document.documentElement.scrollHeight > innerHeight,
        inner: content.scrollHeight > content.clientHeight + 1 };
    })()`);
    console.log(`Desktop screen ${i}:`, fit);
    const denseEntities =
      i === 6 &&
      evaluate('document.querySelectorAll(".wrapped-entities-slide .wrapped-bar-row").length > 4');
    assert(
      !fit.outer && (!fit.inner || denseEntities),
      `Desktop screen ${i} must fit unless its entity list is dense`,
    );
    if (i === 3 || i === 6) {
      const cardGap = evaluate(`(() => {
        const card = document.querySelector('.wrapped-agent-pass');
        const row = document.querySelector('.wrapped-bar-row');
        return card && row ? row.getBoundingClientRect().top - card.getBoundingClientRect().bottom : null;
      })()`);
      if (cardGap !== null) assert(cardGap >= 20, 'Rows clear the tilted card and its shadow');
      assert(
        evaluate(`Array.from(document.querySelectorAll('.wrapped-bar-row')).every(row => {
          const label = row.querySelector('.relative > span').getBoundingClientRect();
          const count = row.querySelector('[title] > span').getBoundingClientRect();
          return Math.abs(label.top + label.height / 2 - count.top - count.height / 2) <= 0.75;
        })`),
        'Row counters are vertically centered with their labels',
      );
    }
    if (i === 6) {
      assert(
        evaluate(
          '!!document.querySelector(".wrapped-entity-totals") && !document.querySelector(".wrapped-entity-index")',
        ),
        'Entities use the session-card presentation, not the old index',
      );
      const entityPass = evaluate(
        'document.querySelector(".wrapped-entities-slide .wrapped-agent-pass .wrapped-figure")?.getBoundingClientRect().width ?? null',
      );
      if (entityPass !== null) {
        assert(entityPass > 100, 'The entity counter remains visible');
        assert(
          evaluate(
            'document.querySelector(".wrapped-entities-slide .wrapped-agent-pass").textContent.includes("memories with this type")',
          ),
          'Entity counters use memories, not entity identities',
        );
        assert(
          evaluate(
            'Array.from(document.querySelectorAll(".wrapped-entities-slide .wrapped-bar-row")).every(e => e.textContent.includes("memories") && !e.textContent.includes("Other"))',
          ),
          'Every remaining type has its own memory count',
        );
      }
    }
    if (i === 7) {
      assert(
        evaluate(
          '!!document.querySelector(".wrapped-project-count") && !document.querySelector(".wrapped-project-mosaic")',
        ),
        'Projects use the file-card direction',
      );
      assert(
        evaluate(
          'document.querySelectorAll(".wrapped-project-deck .wrapped-type-file").length <= 5',
        ),
        'Project cards remain bounded',
      );
    }
    if (i < 10) browser('press', 'ArrowRight');
  }
  for (const [width, height] of [
    [1280, 720],
    [390, 844],
    [320, 640],
  ]) {
    browser('set', 'viewport', String(width), String(height));
    browser('press', 'Home');
    for (let i = 0; i < 5; i++) browser('press', 'ArrowRight');
    for (const title of ['Your technical universe.', 'Where you focused.']) {
      browser('wait', '--text', title);
      const fit = evaluate(
        `(() => { const e = document.querySelector('.wrapped-content'); return { outer: document.documentElement.scrollHeight > innerHeight, horizontal: document.documentElement.scrollWidth > innerWidth, inner: e.scrollHeight > e.clientHeight + 1 }; })()`,
      );
      console.log(title, width, height, fit);
      assert(!fit.outer && !fit.horizontal, 'New scenes stay within the viewport');
      const denseEntities =
        title === 'Your technical universe.' &&
        evaluate(
          'document.querySelectorAll(".wrapped-entities-slide .wrapped-bar-row").length > 4',
        );
      if (width > 480)
        assert(!fit.inner || denseEntities, 'Desktop scenes fit unless the entity list is dense');
      if (title === 'Your technical universe.') {
        browser('press', 'ArrowRight');
      }
    }
  }
  console.log(
    'PASS: autoplay, pause/hold, taps, keyboard, reduced motion, layout, native-share API payload/activation/cancel/retry. Native OS sheet itself is not automated.',
  );
} finally {
  browser('set', 'media', 'dark');
  browser('open', url.href);
}
