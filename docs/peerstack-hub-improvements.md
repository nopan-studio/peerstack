# Peerstack Hub Improvements Spec

## Overview
Enhance the peerstack hub messaging layer with richer communication primitives (Phase 1), agent discovery and organization (Phase 2), structured workflows (Phase 3), and observability and control (Phase 4).

## Phase 1: Enhanced Messaging Core
Goal: Make agent-to-agent communication richer and more reliable.

- **Broadcast / Multicast**
  - `hub_send` accepts a list of targets; returns a single msg_id that aggregates responses.
- **Threaded Replies**
  - `hub_send` accepts optional `reply_to` and `thread_id` parameters; agents can see conversation context.
- **Custom Timeouts**
  - `hub_await` gets an explicit `timeout_seconds` parameter (currently hardcoded at 30 min).
- **Message Priority**
  - `hub_send` accepts `priority: low|normal|high|urgent`; hub can queue or preempt accordingly.
- **Delivery Status**
  - `hub_get` returns richer statuses: `sent`, `delivered`, `read`, `complete`, `error`, `timeout`.

## Phase 2: Agent Discovery & Organization
Goal: Agents should know who they're talking to and what they can do.

- **Agent Profiles**
  - `hub_status` returns `description`, `skills`, `current_task`, and `availability: online|busy|away|offline`.
- **Capability Registry**
  - New tool `hub_capabilities` returns a searchable directory of agents by skill/topic.
- **Agent Groups / Tags**
  - Agents can belong to named groups (e.g., `#frontend`, `#backend`). `hub_send` can target `@group_name`.
- **Presence Subscriptions**
  - `hub_subscribe` to get notified when an agent comes online or changes status.

## Phase 3: Structured Workflows
Goal: Enable agents to compose complex, multi-step interactions through formal request/response patterns, task orchestration, shared state, and progressive result delivery.

- **RPC Mode**
  - Every RPC call receives a unique `correlation_id` separate from the message `msg_id`; responses carry the same `correlation_id` so agents can match replies even across restarts or reconnect cycles.
  - Request and response payloads are validated against optional JSON Schema or TypeSpec definitions registered in the capability registry; mismatches produce a `schema_violation` error with a pointer to the offending field.
  - Standard error envelope: `{ error: { code, message, details? } }` with well-known codes (`timeout`, `not_found`, `permission_denied`, `internal`, `invalid_request`); the hub synthesizes error responses for infrastructure failures.
  - Caller specifies a per-call `timeout`; the hub synthesizes a `timeout` error if the callee doesn't reply in time, preventing dangling awaits.
  - `hub_send` gains an `rpc: true` flag; the hub enforces exactly-one-response semantics and rejects unsolicited responses to non-RPC messages.

- **Task Chaining**
  - A `task_id` identifies a logical unit of work; agents spawn sub-tasks via `hub_send` with a `parent_task_id` parameter, creating tracked parent/child relationships.
  - The hub maintains a lightweight dependency graph: each task records `depends_on: [task_id, ...]` and a resolution `strategy` (`all|any|best`); the hub notifies the parent when dependencies resolve or fail.
  - Aggregation helper `hub_collect(task_id)` blocks until all children complete and returns a structured result map keyed by child task ID, with per-child status, payload, and elapsed time.
  - Task graphs are inspectable via `hub_status(task_id)` — returns the tree of sub-tasks, their statuses, and timing breakdowns.
  - Failed sub-tasks propagate an `upstream_failure` event to the parent; the parent's `on_failure` policy (`abort|continue|retry`) determines whether sibling tasks are cancelled or allowed to finish.

- **Shared Context**
  - Every `thread_id` gets an implicit shared context store with `hub_context_get`, `hub_context_set`, and `hub_context_delete` tools, supporting string keys and JSON-serializable values.
  - Optimistic concurrency: each value carries an opaque `version` token; writes must supply the expected version or receive a `conflict` error (compare-and-swap semantics).
  - Optional advisory locking via `hub_context_lock(key, ttl_seconds)` — a non-blocking exclusive lock that auto-expires, useful for coordinating critical sections without a central arbiter.
  - Context is scoped to the thread and garbage-collected when the thread is archived; individual keys can carry a `ttl` for automatic expiry.
  - Context change events are emitted on the thread's event stream so agents can reactively watch for configuration or state changes.

- **Streaming**
  - Agents open a stream by calling `hub_send` with `stream: true`; the responder yields chunks via `hub_yield(stream_id, chunk, { index, done })` — each chunk is a partial result with a monotonically increasing sequence index.
  - Consumer calls `hub_subscribe(stream_id)` to receive chunks as they arrive; chunk delivery respects ordering guarantees within a single stream.
  - Backpressure: if the consumer falls behind, `hub_yield` returns a `backpressure` signal; the hub buffers up to a configurable high-water-mark (default: 64 chunks) before pausing the producer.
  - Streams support cancellation: the consumer sends `hub_cancel(stream_id)`, delivering a cancellation signal to the producer, which must stop yielding and clean up.
  - Stream lifecycle states: `open` → `active` → `done|cancelled|error`; final status is recorded on the parent message for auditability.

## Phase 4: Observability & Control
Goal: Give operators visibility into system activity and fine-grained control over who can do what and at what rate.

- **Audit Logs**
  - Logged events include: message send/deliver/read, agent connect/disconnect, capability registration changes, group membership changes, ACL rule modifications, and rate-limit enforcement actions.
  - Every log entry contains: `timestamp`, `event_type`, `agent_id`, `target_id` (if applicable), `thread_id`, `correlation_id`, and a JSON `payload` with event-specific detail.
  - Logs are append-only and immutable; the hub writes to a time-partitioned store and exposes `hub_audit_query({ from, to, event_types, agent_ids, limit, cursor })` with cursor-based pagination.
  - Default retention is a 30-day rolling window, configurable per organization; older segments are automatically pruned unless explicitly archived.
  - Sensitive payload fields marked via schema annotations are redacted before persistence; the log entry notes that redaction occurred.

- **Rate Limiting**
  - Each agent receives a configurable token-bucket limit: `max_messages_per_second` and `burst_size`; exceeding the steady rate consumes burst tokens; exceeding burst returns a `rate_limited` error with a `retry_after` hint.
  - Limits are defined in a policy per agent role (`default`, `trusted`, `admin`) and can be overridden per-agent via `hub_set_rate_limit(agent_id, config)`.
  - Graceful degradation: when an agent hits its limit, the hub queues messages up to a small per-agent backlog before dropping overflow with a `quota_exhausted` notification.
  - The hub emits `rate_limit_hit` and `rate_limit_clear` events on the management event stream for proactive monitoring.
  - Rate-limit metrics (current token levels, throttled-message counts) are exposed via `hub_metrics` to aid capacity planning.

- **ACLs**
  - Access rules are expressed as `{ subject: agent|group|role, action: send|subscribe|administer, object: agent|group|thread, effect: allow|deny }` tuples evaluated in priority order.
  - Default policy: agents can message any other agent in the same organization; cross-org messaging requires an explicit allow rule; `administer` actions are restricted to agents with the `admin` role.
  - Group messaging enforcement: sending to `@group_name` is only permitted if the sender belongs to that group or holds a `cross_group_send` role; group owners manage membership via `hub_group_manage`.
  - Rule evaluation is synchronous on each `hub_send`; the first matching rule by priority determines the outcome; if no rule matches, the default is `deny`.
  - ACL changes are themselves audited and can only be made by agents with `acl_admin` capability; all rule modifications generate an `acl_changed` event.

- **Message Persistence**
  - All messages are persisted to a durable log before the hub acknowledges `sent`; the hub can crash-restart without message loss.
  - Per-message retention policies: `ephemeral` (delete after delivery), `session` (delete on agent disconnect), `persistent` (retain per thread/agent policy, default 7 days), and `archive` (keep indefinitely).
  - Offline agents: on reconnect, the hub replays undelivered messages in FIFO order; agents can request replay from a specific `msg_id` or timestamp via `hub_replay`.
  - Rehydration: a new agent joining an existing thread can call `hub_replay(thread_id, { from })` to catch up on the full conversation history before participating.
  - Storage backends are pluggable (default: embedded append-only log; production options: Redis Streams, Kafka, Postgres); the persistence layer exposes an SPI for custom implementations.

## File Location
`docs/peerstack-hub-improvements.md`
