import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('signed-in users retain a visible cloud account control for logout and account switching', () => {
  const app = fs.readFileSync('src/App.tsx', 'utf8');

  assert.match(
    app,
    /data-testid="cloud-account-button"[\s\S]*?onClick=\{\(\) => setIsCloudAccountOpen\(true\)\}/,
  );
  assert.match(app, /onSignOut=\{\(\) => void signOutCloudAccount\(\)\}/);
});

test('logout only clears this device session', () => {
  const supabase = fs.readFileSync('src/utils/supabase.ts', 'utf8');

  assert.match(supabase, /api\.auth\.signOut\(\{\s*scope:\s*'local'\s*\}\)/);
});

test('background saving skips unchanged cloud workspaces', () => {
  const app = fs.readFileSync('src/App.tsx', 'utf8');
  const saveCurrentWorkspace = app.slice(
    app.indexOf('  function saveCurrentWorkspace({'),
    app.indexOf('  function capturePredictionHistory('),
  );

  assert.match(
    saveCurrentWorkspace,
    /if \(!force && !hasUnsavedChanges\) return;\s*\n\s*capturePredictionHistory\(predictions, data\);/,
  );
});
