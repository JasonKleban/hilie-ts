import { test, expect } from '@playwright/test';

// Helper: load demo page served from local dist
const loadDemo = async (page) => {
  await page.goto('file://' + process.cwd() + '/dist/index.html');
  await page.waitForSelector('#app');
};

// Helper: paste sample content into textarea/file view if demo supports pasting -- otherwise ensure the shipped dist contains example content
// These tests assume the demo renders the sample file contents into elements with data-file-start attributes

test.describe('Selection mapping', () => {
  test('single-line selection maps to correct start/end lines', async ({ page }) => {
    await loadDemo(page);

    // select a visible text node in the first record
    const firstRecord = await page.locator('[data-file-start]').first();
    await firstRecord.click();

    // simulate user selection: select first 10 characters
    await page.evaluate(() => {
      const el = document.querySelector('[data-file-start]');
      const range = document.createRange();
      const textNode = el.firstChild as Text;
      range.setStart(textNode, 0);
      range.setEnd(textNode, 10);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    // Click Record button
    await page.click('button#record');

    // Wait for feedback history to show
    await expect(page.locator('#feedback-history .item')).toHaveCount(1);

    const text = await page.locator('#feedback-history .item .lines').innerText();
    // Expect lines like "lines 0-0" or similar
    expect(text).toMatch(/0-0/);
  });

  test('multi-line selection across double-newline maps correctly', async ({ page }) => {
    await loadDemo(page);

    // Find an element that includes consecutive newlines in its underlying text
    const el = await page.locator('[data-file-start]').first();

    await page.evaluate(() => {
      // create a selection that spans the first two line breaks
      const el = document.querySelector('[data-file-start]');
      const textNode = el.firstChild as Text;
      // find indices near double newlines
      const s = textNode.textContent;
      const idx = s.indexOf('\n\n');
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(textNode, Math.max(0, idx - 2));
        range.setEnd(textNode, Math.min(s.length, idx + 3));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });

    await page.click('button#record');

    await expect(page.locator('#feedback-history .item')).toHaveCount(1);

    const text = await page.locator('#feedback-history .item .lines').innerText();
    // selection that touches double newlines should not jump beyond intended lines
    expect(text).toMatch(/0-\d+/);
  });

  test('selection containing zero-width placeholders is sanitized', async ({ page }) => {
    await loadDemo(page);

    // Insert a zero-width char into the rendered content for test (if not already present)
    await page.evaluate(() => {
      const el = document.querySelector('[data-file-start]');
      const tn = el.firstChild as Text;
      tn.textContent = '\u200B' + tn.textContent;
    });

    await page.evaluate(() => {
      const el = document.querySelector('[data-file-start]');
      const textNode = el.firstChild as Text;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 2);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });

    await page.click('button#record');
    await expect(page.locator('#feedback-history .item')).toHaveCount(1);

    const linesText = await page.locator('#feedback-history .item .lines').innerText();
    expect(linesText).toMatch(/0-0/);
  });
});
