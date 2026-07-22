# Stable Parent Cluster Navigation

## Overview

Keep parent clusters in their initial order while live include/exclude counts change.

## Implementation Details

### Slice 1 — Stable ordering [parallel]

**File**: `src/cluster-order.ts`

**Parallel-safe**: yes

Capture immutable original ordering data and expose a stable ordering helper. Do not change membership calculations.

**Acceptance Criteria**:

- Initial ordering is descending by original raw topic count.
- Excluding and re-including items changes counts but not parent order.

### Slice 2 — Regression tests [parallel]

**File**: `src/cluster-order.test.ts`

**Parallel-safe**: yes

Add behavioral regression coverage for exclude/include operations.

**Acceptance Criteria**:

- The test fails against live-count sorting.
- The test passes when original order is preserved.

## Final Validation

```sh
npm test
npm run typecheck
git diff --check
```
