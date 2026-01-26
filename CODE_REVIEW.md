# Code Review Report: Antigravity FuelGauge

## 1. Executive Summary

**Overall Status:** ✅ **Secure & Functional**

The codebase represents a mature, well-structured VS Code extension. The claims of being a "secure, audited fork" are substantiated by the effective disablement of telemetry and secure handling of credentials. The architecture separates concerns well (Engine, Controllers, View), and robustness is built-in via retries and defensive programming.

**Key Strengths:**
*   **Security:** Telemetry is dead-coded. Credentials use `vscode.SecretStorage`. Webviews use strict CSP.
*   **Robustness:** Extensive retry logic for process discovery and API calls.
*   **Code Style:** Consistent TypeScript usage, clean linting results.

**Key Weaknesses:**
*   **Test Coverage:** Very low. Critical logic (quota calculation, auto-trigger) is untested.
*   **Concurrency:** Potential race conditions in multi-account quota checks if network latency is high.

---

## 2. Security Assessment

### 2.1 Telemetry & Privacy
*   **Status:** **PASSED**
*   **Findings:**
    *   `src/shared/error_reporter.ts` is stubbed out. No data is sent to Sentry or external services.
    *   `package.json` defaults `agCockpit.telemetryEnabled` to `false` and marks it deprecated.
    *   The extension only communicates with:
        1.  Local "Antigravity" server (`127.0.0.1`).
        2.  Verified "Antigravity Tools" APIs (via `cloudCodeClient`).

### 2.2 Credential Handling
*   **Status:** **PASSED**
*   **Findings:**
    *   `src/auto_trigger/credential_storage.ts` correctly uses `vscode.SecretStorage` for OAuth tokens.
    *   Tokens are never logged (except potentially in debug logs if `JSON.stringify` is used on objects containing them, though I didn't see explicit logging of raw tokens).

### 2.3 Injection Risks
*   **Status:** **PASSED**
*   **Findings:**
    *   `sql.js` usage in `src/auto_trigger/local_auth_importer.ts` uses parameterized queries (`stmt.bind([STATE_KEY])`), preventing SQL injection.
    *   Webviews use strict CSP with nonces (`script-src 'nonce-${nonce}'`).

### 2.4 Local File Access
*   **Status:** **ACCEPTABLE**
*   **Findings:**
    *   The extension reads from `~/.antigravity` and `~/.antigravity_tools`. This is expected behavior for a tool integrating with local software.

---

## 3. Code Quality & Architecture

### 3.1 Structure
*   **Status:** **GOOD**
*   **Findings:**
    *   Clear separation:
        *   `engine/`: Core logic (Reactor, Hunter).
        *   `controller/`: Business logic gluing UI and Engine.
        *   `view/`: UI code.
        *   `services/`: Specific features.
    *   Singleton pattern used effectively for services (`schedulerService`, `credentialStorage`).

### 3.2 Reliability & Error Handling
*   **Status:** **GOOD**
*   **Findings:**
    *   `ReactorCore` has exponential backoff for initialization.
    *   `ProcessHunter` tries multiple strategies (Windows/Unix).
    *   `try-catch` blocks are ubiquitous around external calls.

### 3.3 Testing
*   **Status:** **POOR**
*   **Findings:**
    *   Only `src/engine/strategies.test.ts` exists.
    *   **Critical Missing Tests:**
        *   Quota snapshot parsing (`ReactorCore`).
        *   Auto-trigger scheduling logic (`SchedulerService`).
        *   Multi-account switching logic.

---

## 4. Logic & Functionality

### 4.1 Quota Calculation
*   **Status:** **FUNCTIONAL**
*   **Analysis:**
    *   The extension polls the local server or remote API every 120s.
    *   Grouping logic (`calculateGroupMappings`) is complex but seems robust, using "fingerprinting" to group models with identical quotas.

### 4.2 Auto-Trigger
*   **Status:** **FUNCTIONAL**
*   **Analysis:**
    *   `SchedulerService` uses `setTimeout` based on cron parsing.
    *   `checkQuotaResetTrigger` runs on every poll.
    *   **Potential Issue:** In `AutoTriggerController.checkAndTriggerOnQuotaReset`, the loop over accounts is sequential. If one account's API call hangs (timeout 30s), it delays checks for subsequent accounts.

---

## 5. Performance & Resource Usage

*   **Status:** **GOOD**
*   **Findings:**
    *   Polling interval is reasonable (120s).
    *   `cockpitToolsWs` uses event-driven updates.
    *   One-time startup sync for "Antigravity Tools" avoids repetitive disk I/O.
    *   `https.request` uses `agent: false` to avoid socket exhaustion.

---

## 6. Recommendations

### Priority 1: High (Stability)
1.  **Add Concurrency Lock for Quota Checks:** Modify `AutoTriggerController.checkAndTriggerOnQuotaReset` to prevent overlapping executions if the previous check takes longer than the polling interval.

### Priority 2: Medium (Quality)
1.  **Add Unit Tests:** Create tests for `SchedulerService` (verifying cron parsing) and `ReactorCore` (verifying JSON parsing and quota grouping).
2.  **Fix ESLint Config:** Migrate `.eslintrc.json` to `eslint.config.js` or fix dependency versions to ensure linting works out-of-the-box for contributors.

### Priority 3: Low (Polish)
1.  **Fix Lint Warnings:** Address the missing trailing commas in `src/auto_trigger/credential_storage.ts`.

---
