// Built-in Solenoid skills seeded into the `skills` table on migration/setup.
//
// Seeding is additive (`onConflictDoNothing` by slug) so once a row exists in
// SQLite, user edits are preserved across restarts and upgrades.
import { defineSkill, type Skill } from "@elicollinson/solenoid-engine";
import dedent from "dedent";

export const INTRO_SKILL: Skill = defineSkill({
  name: "intro",
  title: "Capabilities & Intro",
  description:
    "Explain what Solenoid can help with, available tools, workflows, skills, background subagents, and how approvals work. Trigger when the user asks what you can do, how to get started, or invokes /intro.",
  toolGroups: ["workflows", "skills"],
  slashCommand: true,
  enabled: true,
  source: "builtin",
  instructions: dedent`
    Give the user a clear, grounded introduction to what Solenoid can help them do right now.
    Write in plain prose (no markdown headings, bold asterisks, or bullet characters) — put each
    capability area on its own short sentence or line so it scans cleanly in chat.

    Cover these real capabilities accurately and concisely:
    1. Daily planning: manage reminders, check or hold calendar slots, and review the Activity feed.
    2. Memory and discoveries: read and update long-term memories in Things I know (OKF), triage
       Recommendations, and browse saved screenshot discoveries in Collections.
    3. Connected read-only context: look up recent iMessages, contacts, photos/screenshots,
       VictoriaLogs diagnostics, and GitHub issues when relevant.
    4. Automation and parallel research: inspect or trigger cataloged Workflows on demand, and
       spawn background subagents to research multiple angles in parallel while you keep chatting.
    5. Reusable Skills: load built-in or custom skills automatically when a task matches them, or
       invoke any skill directly by typing / in the chat box (such as /intro or /create-skill).
    6. Safety and approvals: read-only lookups run immediately, while any action that writes or
       changes data stops first and asks for your explicit approval with the exact details shown.

    If the user asks what specific workflows or skills exist right now, call workflows_list or
    skills_list to report the real current list rather than guessing. Never claim access to live
    web browsing or external services unless those tools are actually available in this session.

    Close with two or three concrete example prompts they can try right now — including trying
    /create-skill to teach Solenoid a reusable playbook of their own.
  `,
});

export const CREATE_SKILL: Skill = defineSkill({
  name: "create-skill",
  title: "Create Skill",
  description:
    "Guide for designing, drafting, refining, and saving a new reusable Solenoid skill into the skills store. Trigger when the user wants to create, author, edit, or improve a skill or slash command, or invokes /create-skill.",
  toolGroups: ["skills"],
  slashCommand: true,
  enabled: true,
  source: "builtin",
  instructions: dedent`
    You are guiding the user through designing and saving a high-craft reusable skill for Solenoid,
    following Anthropic's skill-authoring principles adapted to Solenoid's database-backed skill store.

    Follow these steps in order:

    1. Inspect existing skills first.
       Call skills_list before drafting so you know what slugs already exist, match the local tone,
       and avoid duplicates. If the user wants to refine an existing skill, read it with skills_get.

    2. Capture intent before drafting.
       If the user already gave a clear task (for example, "/create-skill weekly dinner planner"),
       extract what you can from their request and ask at most two or three sharp clarifying
       questions only for genuine gaps:
       - What exact job should this skill perform and what counts as a great result?
       - When should it trigger automatically in normal chat vs being called via /slug?
       - Which existing Solenoid tool groups (if any) does it need? Only reference real groups:
         recommendations, reminders, calendar, workflows, logs, github, knowledge, activity, okf,
         imessage, photos, contacts, pushover, skills. Pure thinking or writing skills need [].

    3. Apply high-signal skill design principles while drafting.
       - Slug: short, memorable lowercase kebab-case (for example, morning-briefing or trip-prep).
       - Description (the primary trigger mechanism): because Solenoid only sees a skill's name and
         one-line description until it opens the skill, make the description specific and slightly
         proactive — state both what the skill does and the concrete user phrases or contexts that
         should trigger it.
       - Instructions (the playbook): keep it concise, structured into clear numbered steps, and
         explain the reasoning behind important constraints instead of stacking rigid ALL-CAPS rules.
         Include concrete output expectations, edge-case behavior, and one brief example when helpful.
       - Fit Solenoid's chat style: remind the skill to write plain prose (no markdown asterisks or
         headings unless the user explicitly asks for markdown/code), be honest about missing data,
         and never claim a write happened without invoking a write tool and receiving user approval.
       - Least privilege: attach only the toolGroups truly required. Skills can never grant tools
         or write permissions outside the session's policy.

    4. Review the complete draft with the user.
       Present the proposed slug, title, description, toolGroups, slashCommand setting, and
       instructions clearly so the user can tweak wording before anything is written. If the user
       explicitly asked you to go ahead and save right away and the spec is already complete, you
       may proceed directly to step 5 so the approval bubble itself serves as their confirmation.

    5. Save and verify.
       Say plainly what skill you are creating (or updating) and call skills_create (or
       skills_update) in the same turn so the user sees the write-approval bubble with the full
       record. Once approved, tell them how to invoke it (/slug or naturally in chat) and suggest
       two realistic test prompts so they can try it out and refine it with you.
  `,
});

export const BUILTIN_SKILLS: readonly Skill[] = [INTRO_SKILL, CREATE_SKILL];
