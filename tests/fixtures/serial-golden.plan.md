# Serial golden

A three-slice plan whose compiled shape pins today's serial topology.

### Slice 1 — Types

**Files**: `src/types.ts`

**Parallel-safe**: no

Add the types.

**Acceptance Criteria**:
- Types compile.

**Targeted Validation**:
```sh
npm run check
```

### Slice 2 — Runtime

**Files**: `src/runtime.ts`

**Parallel-safe**: yes

**Needs**:
- Slice 1 — Types

Wire the runtime.

**Acceptance Criteria**:
- Runtime uses the new types.

**Targeted Validation**:
```sh
npm run check
npm test
```

### Slice 3 — Docs

**Files**: `docs/GUIDE.md`

**Parallel-safe**: yes

**Needs**:
- Slice 2 — Runtime

Document the change.

**Acceptance Criteria**:
- Guide mentions the new types.

**Targeted Validation**:
```sh
npm test
```
