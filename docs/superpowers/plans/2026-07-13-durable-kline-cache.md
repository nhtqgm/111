# Durable K-Line Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the latest valid real K-line history after browser refresh or EXE restart without restoring local prediction data.

**Architecture:** Add a focused K-line cache module that owns validation, browser persistence, Electron merge/bootstrap, and the last market scope. Wire it into pre-render startup and the existing App refresh/switch flow while leaving cloud prediction storage unchanged.

**Tech Stack:** React 19, TypeScript, localStorage, Electron IPC storage, Node test runner.

---

### Task 1: Specify durable K-line storage behavior

**Files:**
- Create: `scripts/kline-cache.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing tests for validated save/load, last scope, and Electron bootstrap**
- [ ] **Step 2: Run `npm run test:kline-cache` and verify failure because the cache module does not exist**
- [ ] **Step 3: Add the test command to `package.json`**

### Task 2: Implement the focused cache module

**Files:**
- Create: `src/utils/kLineCache.ts`
- Modify: `src/utils/predictions.ts`

- [ ] **Step 1: Implement versioned cache keys and strict K-line validation**
- [ ] **Step 2: Implement browser save/load and last-scope save/load**
- [ ] **Step 3: Implement Electron bootstrap that restores only valid K-line entries**
- [ ] **Step 4: Re-export legacy cache APIs from `predictions.ts` for compatibility**
- [ ] **Step 5: Run `npm run test:kline-cache` and verify all tests pass**

### Task 3: Wire persistence into application startup and refresh

**Files:**
- Modify: `src/main.tsx`
- Modify: `src/App.tsx`
- Modify: `scripts/kline-cache.test.ts`

- [ ] **Step 1: Add failing integration assertions for pre-render bootstrap, cache loading, and refresh saving**
- [ ] **Step 2: Initialize the App selection from the last cached market scope**
- [ ] **Step 3: Load persisted K-line data whenever memory has no selected scope**
- [ ] **Step 4: Save every successful period refresh and preserve raw source metadata**
- [ ] **Step 5: Keep cached history visible when online refresh fails**
- [ ] **Step 6: Run the focused tests and verify they pass**

### Task 4: Regression verification

**Files:**
- Modify only if a regression is found in files already in scope.

- [ ] **Step 1: Run all Node tests under `scripts`**
- [ ] **Step 2: Run `npm run verify:ma`**
- [ ] **Step 3: Run `npm run build`**
- [ ] **Step 4: Confirm the original `main` worktree remains unchanged**
- [ ] **Step 5: Commit only the feature work on `codex/fix-durable-kline-cache`**

