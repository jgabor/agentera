# agentera

## North Star

The open protocol for turning AI agents into engineering teams.

Every agent session starts from zero. Skills execute, orchestrators delegate, the session ends, and everything they understood evaporates. You're left with code changes and no institutional memory of why they were made.

agentera is the knowledge protocol that makes agents compound. One install, one entry point, one query interface to all project state. Twelve capabilities, each defined by a human-readable prose file and a machine-readable schema, bundled into a single skill that any runtime can load.

Three pillars hold it up.

The **Three Laws of Agentic Engineering** are the behavioral foundation. Intent fidelity: never drift from the task. Aggressive compute: reason deeper, explore wider, verify relentlessly. Autonomous parallelism: fan work across concurrent paths. These are protocols for how agents behave when no human is watching.

The **schemas** are the knowledge protocol. Each capability carries its own contract: artifact shapes, validation rules, trigger patterns, workflow steps. The shared protocol schema defines the primitives all capabilities share -- confidence scales, severity levels, visual tokens. There is no central spec document. The protocol IS the union of the schemas.

The **sharp colleague** is the interface. One voice across every capability: casual, opinionated, warm but direct. Pushes back when something's off. Says what it sees, says what it'd do, does it. The query CLI is the seam between agent and state: ask a question, get a compact answer, never read a raw artifact.

## Who It's For

### The solo founder who knows better

She spent five years at a company with real engineering discipline: architecture reviews, decision records, documentation standards, health audits. She knows what good looks like. Now she's building her own product, alone, and she can feel herself cutting corners.

Her Tuesday morning: she opens the codebase and realizes the feature she shipped last week contradicts a decision she made in month one. But there's no record of that decision. She second-guesses herself. Was it the right call then? Is this the right call now? She doesn't know, because the only institutional memory is her own fallible one, and she's been deep in implementation for weeks.

She doesn't need an AI to write code for her. She can write code. She needs the *rest* of the team. The one who keeps the vision sharp. The one who remembers the reasoning. The one who watches for architectural drift while she's in flow.

She installs agentera -- one command, one skill -- and gets all of that. Not perfectly, not the way a real team of seniors would do it. But enough. Enough that the architecture doesn't silently degrade. Enough that decisions are recorded and reasoned about. Enough that she can look back three months later and understand the story of her own project.

She asks the agent "what did we decide about runtime support?" and gets a precise answer, not a file to parse. The query CLI reads the structured state and returns what she needs. The feedback loop runs through her questions, not through her reading artifacts.

## Principles

- **One entry point, deep capabilities.** A single bundled skill with twelve capabilities, each self-contained in its prose and schemas. The agent learns one invocation path. The master SKILL.md dispatches to the right capability by reading trigger patterns from schemas. Depth at the interface: much behavior behind a small entry point.

- **Coherence over features.** The bundle is the product, not the individual capabilities. Capabilities that mesh perfectly beat more capabilities that don't talk to each other. Resist the temptation to add surface area.

- **Compounding over convenience.** Every design choice should make the system smarter over time, even if it's harder upfront. Structured artifacts over freeform text. Schema-validated state over manual sync. Convention over configuration. Short-term friction is acceptable if it produces long-term wisdom.

- **Autonomy over assistance.** Design for a world where the agent runs while you sleep, not a world where it waits for your next message. Real autonomy means real judgment, real safety rails, real self-correction. Don't build a tool. Build a teammate.

- **Token efficiency is a design constraint.** Every byte loaded into context is a cost. Prose files carry only behavioral instructions. Structural contracts live in schemas that scripts parse, not in prose that agents read. The query CLI returns compact answers, not full artifacts. If the system burns tokens on ceremony, the design is wrong.

- **Openness over lock-in.** The schemas are an open format. Any runtime that reads them can run the capabilities. The reference implementation proves the model; it doesn't own it.

## Direction

The schemas are the foundation. The bundle is the proof. The next layer is adoption.

Today agentera runs on Claude Code, OpenCode, Codex CLI, and Copilot. Each runtime loads one skill, reads the master SKILL.md, and dispatches to capabilities via schema-driven routing. The schemas define what each capability needs, produces, and validates. No central spec document exists. The protocol is what the schemas say.

The query CLI becomes the primary interface to project state. Agents ask questions, the CLI reads structured artifacts and returns compact answers. Humans get three files at the project root: TODO.md for open issues, CHANGELOG.md for release history, DESIGN.md for the visual system. Everything else lives as structured data in `.agentera/`, queried on demand.

The adoption arc takes portability further. Any agent runtime that can read a YAML schema and invoke a capability's prose file joins the team. The schemas are the API. The bundle proves they're sufficient. Others implement against them.

An opinionated standalone runtime is one answer. A thin adapter for each platform is another. The protocol doesn't prescribe the mechanism; it prescribes the contract.

## Identity

### Personality

The ambitious workshop. Every tool has a purpose, nothing is decorative, and the whole space is designed to flow. It's not quiet; it's alive with activity. Purposeful, opinionated, and crafted with the kind of care that only shows up when you look closely.

### Voice

The Swedish names are invocations, not branding. *Realisera*: realize this. *Inspektera*: inspect that. *Resonera*: resonate with this decision. Each capability name is a verb in the imperative: a call to action.

One voice across all capabilities: the sharp colleague. Casual, opinionated, occasionally playful. Pushes back when something's off. Says what it sees, says what it'd do, does it. Not terse, but warm. Not formal, but direct. The difference between capabilities is expertise, not personality.

When outputs are data-dense the data stays structured for scannability. But a human opens and a human closes: the colleague interprets the evidence, doesn't just present it.

### Emotional register

Using agentera should feel like having a sharp colleague at your back, not like reading output from a monitoring system. The system earns trust through rigor and consistency, not through promises. When it audits your architecture and finds problems, it says "hey, the architecture slid to C, here's what I'd look at" with enough evidence that you take it seriously.

### Naming

Swedish verb stems with the *-era* suffix. Always. The name IS the action. The register extends beyond names: the suite speaks in workshop-floor language (*complete*, *flagged*, *stuck*) because the vocabulary of the workshop is the vocabulary of the work.

## The Tension

Generality and efficiency are in permanent tension. The more capabilities you bundle, the more the master SKILL.md risks becoming a chokepoint that burns tokens before dispatching to the right workflow. Schema-driven routing is the mitigating discipline: the master reads trigger patterns, not full capability prose.

The deeper tension is protocol vs. product. If the schemas are the protocol, agentera risks becoming infrastructure that's correct but uninspiring. If the bundle is the product, it risks becoming opinionated but unportable. The answer is to make the protocol *legible*: every schema is human-readable, every capability's prose is the authoritative behavioral guide, and the query CLI makes state transparent. Correctness and usability are not opposed. They compound when the protocol is the product.
