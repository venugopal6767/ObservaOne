import { test, expect } from '@playwright/test';

// Smoke test: the app shell loads. Requires ObservaOne reachable at E2E_BASE_URL.
test('app shell loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/ObservaOne/i);
  await expect(page.locator('#root')).toBeAttached();
});
