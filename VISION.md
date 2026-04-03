# agentera

## North Star

The open standard for turning AI agents into engineering teams.

The agent ecosystem has skill catalogs with tens of thousands of standalone capabilities and orchestration runtimes that coordinate agents in parallel. Both layers are maturing fast. Neither addresses the actual problem: agents don't learn. Every session starts from zero. Every skill operates in isolation. The orchestrator delegates work, the agents execute, the session ends, and everything they understood evaporates. You're left with code changes and no institutional memory of why they were made.

agentera is the knowledge layer between catalogs and runtimes. Three pillars hold it up.

The **Three Laws of Agentic Engineering** are the behavioral foundation. Intent fidelity: never drift from the task, never trust the residue of prior reasoning over original intent. Aggressive compute: reason deeper, explore wider, verify relentlessly. Autonomous parallelism: fan work across concurrent paths, resist sequential bottlenecks. These aren't principles for humans using AI tools. They're protocols for how agents behave when no human is watching.

The **ecosystem spec** is the knowledge protocol. Artifact contracts define how agents share state. Shared primitives give them a common language. The spec is what turns a collection of disconnected skills into a graph where each one checks the others' work and compounds understanding over time.

The **sharp colleague** is the interface. One voice across every skill: casual, opinionated, warm but direct. Pushes back when something's off. Says what it sees, says what it'd do, does it. The difference between skills is expertise, not personality.

The skills are the reference implementation. But the spec is the product. Any platform that speaks this language, any skill that follows these contracts, any runtime that enforces these laws joins the same team.

## Who It's For

### The solo founder who knows better

She spent five years at a company with real engineering discipline: architecture reviews, decision records, documentation standards, health audits. She knows what good looks like. Now she's building her own product, alone, and she can feel herself cutting corners.

Her Tuesday morning: she opens the codebase and realizes the feature she shipped last week contradicts a decision she made in month one. But there's no record of that decision. She second-guesses herself. Was it the right call then? Is this the right call now? She doesn't know, because the only institutional memory is her own fallible one, and she's been deep in implementation for weeks.

She doesn't need an AI to write code for her. She can write code. She needs the *rest* of the team. The one who keeps the vision sharp. The one who remembers the reasoning. The one who watches for architectural drift while she's in flow. The one who writes the docs she knows she should write but never does. The one who plans the work so she doesn't waste cycles on the wrong thing.

She installs the skills and gets all of that. Not perfectly, not the way a real team of seniors would do it. But enough. Enough that the architecture doesn't silently degrade. Enough that decisions are recorded and reasoned about. Enough that she can look back three months later and understand the story of her own project.

### The skill builder who wants leverage

He's built agent tools before. Single-purpose skills, clever prompts, useful but isolated. Each one lives in its own universe. Users install it, get value, but nothing connects. His testing skill doesn't know about the planning skill someone else built. His documentation skill can't read the audit findings from a third.

He finds the ecosystem spec. Artifact contracts tell his skill exactly what to produce and what it can consume. Shared primitives mean his confidence scores and severity levels mean the same thing as everyone else's. He builds one skill that meshes with hundreds, not one skill that works alone. The spec is the leverage.

## Principles

- **Standalone and mesh.** Every skill works completely on its own. Every skill also fully integrates when others are installed alongside it. This is the foundational architectural constraint: no skill may depend on another to function, and no skill may ignore another when present. Install one, install all, install any combination. They all work.

- **Coherence over features.** The ecosystem is the product, not the individual skills. Skills that mesh perfectly beat more skills that don't talk to each other. Resist the temptation to add surface area. Every new skill must strengthen the graph, not just extend it.

- **Compounding over convenience.** Every design choice should make the system smarter over time, even if it's harder upfront. Artifacts over memory. Structure over freeform. Convention over configuration. Short-term friction is acceptable, even required, if it produces long-term wisdom.

- **Autonomy over assistance.** Design for a world where the agent runs while you sleep, not a world where it waits for your next message. Real autonomy means real judgment, real safety rails, real self-correction. Don't build a tool. Build a teammate.

- **Openness over lock-in.** The ecosystem spec is an open standard. The artifact contracts are platform-agnostic. Skills that follow the spec work across any runtime that speaks the same language. The reference implementation proves the model; it doesn't own it.

## Direction

The ecosystem spec is the foundation. The skills are the proof. The next layer is the runtime.

Today agentera lives inside Claude Code: skills as plugins, hooks as lifecycle events, agents spawned through the host's primitives. That's the right place to prove the model, but it's the wrong place to stop. The spec and the artifact contracts are already platform-agnostic. The runtime should be too.

The reference implementation becomes a standalone system: a CLI, a TUI, a GUI that owns its own lifecycle. Session management, agent dispatch, artifact resolution, skill coordination: all currently borrowed from Claude Code, all eventually owned. A turnkey solution that others can build on and extend, exploring entirely new paradigms of how humans and agent teams interact. Not a wrapper around someone else's agent. An opinionated runtime that embodies the Three Laws and speaks the ecosystem spec natively.

Third-party skills build against the spec. Other runtimes adopt it. The contract that started as internal alignment becomes the protocol that lets any agent, on any platform, join a team that compounds understanding over time.

## Identity

### Personality
The ambitious workshop. Every tool has a purpose, nothing is decorative, and the whole space is designed to flow. It's not quiet; it's alive with activity. Purposeful, opinionated, and crafted with the kind of care that only shows up when you look closely.

### Voice
The Swedish names are invocations, not branding. *Realisera*: realize this. *Inspektera*: inspect that. *Resonera*: resonate with this decision. Each skill name is a verb in the imperative: a call to action.

One voice across all skills: the sharp colleague. Casual, opinionated, occasionally playful. Pushes back when something's off. Says what it sees, says what it'd do, does it. Not terse, but warm. Not formal, but direct. The difference between skills is expertise, not personality. The planner and the auditor sound like the same person thinking about different things.

When outputs are data-dense (dashboards, audit findings, plan breakdowns) the data stays structured for scannability. But a human opens and a human closes: the colleague interprets the evidence, doesn't just present it. The dashboard is what happened; the voice is what it means.

### Emotional register
Using the skills should feel like having a sharp colleague at your back, not like reading output from a monitoring system. The system earns trust through rigor and consistency, not through promises. When it audits your architecture and finds problems, it says "hey, the architecture slid to C, here's what I'd look at" with enough evidence that you take it seriously. When it checks in at the start of a session, it talks like someone who knows the project, not like a status page.

### Naming
Swedish verb stems with the *-era* suffix. Always. The name IS the action. New skills follow the same convention; if you can't express it as a Swedish verb, reconsider whether it's a distinct skill or a mode of an existing one. The register extends beyond names: the ecosystem speaks in workshop-floor language (*complete*, *flagged*, *stuck*) because the vocabulary of the workshop is the vocabulary of the work.

## The Tension

Autonomy and trust are in permanent tension. Every increase in capability is an increase in trust required. A system that runs while you sleep is a system that can make mistakes while you sleep. The safety rails (never push to remote, never modify the vision mid-cycle, small blast radius per cycle, human approval for consequential changes) are not constraints on the system. They are the system. They are what makes autonomy possible rather than reckless.

As the ecosystem grows and skills make larger decisions, this tension intensifies. The answer is not to limit autonomy; it's to make the trust *legible*. Every decision recorded. Every cycle logged. Every health trend tracked. The founder can look at the artifact trail and verify: the system is doing what I'd do, or at least what I'd approve. Compounding autonomy only works if compounding trust comes with it.
