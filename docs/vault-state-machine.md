# Vault State Machine

## States

| State | Description |
|-------|-------------|
| `draft` | Initial state |
| `active` | Vault is running |
| `completed` | Terminal - all milestones verified |
| `failed` | Terminal - deadline passed |
| `cancelled` | Terminal - creator cancelled |

## Allowed Transitions

draft → active, cancelled
active → completed, failed, cancelled
completed → (none)
failed → (none)
cancelled → (none)

## Validation Rules

| Transition | Requirement | Error |
|------------|-------------|-------|
| active → completed | All milestones verified | "not all milestones are verified" |
| active → failed | endTimestamp passed | "endTimestamp has not passed" |
| active → cancelled | Creator only | "only the creator can cancel" |