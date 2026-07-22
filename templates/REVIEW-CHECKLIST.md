# Review Checklist

## Approval gate

Approval requires:

- All approved requirements and acceptance criteria are implemented.
- No critical or major findings remain open.
- Deterministic validation is green.
- New behavior has meaningful behavioral coverage or explicitly approved debt.
- The change remains inside its path and scope contract.
- Error and recovery behavior is actionable.
- Architecture and naming follow ARCHI.md.

## Review order

1. Correctness and data-loss risks
2. Security and authorization
3. Plan conformance
4. Failure behavior and recovery
5. Tests and observable edge cases
6. Architecture and maintainability
7. Performance and resource cleanup
8. Unnecessary complexity

## Severity

- **Critical:** security vulnerability, data corruption, auth bypass, irreversible failure
- **Major:** incorrect behavior, missing required work, build/test failure, unsafe recovery
- **Minor:** bounded quality issue that does not invalidate the feature
- **Suggestion:** optional improvement

## Reviewer output

Reviewers must return one structured status:

- `complete`
- `continue`
- `blocked`
- `needs_decision`

Any free-form corrective feedback without a status is conservatively normalized to `continue`.
