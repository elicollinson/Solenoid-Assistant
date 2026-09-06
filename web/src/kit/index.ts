// The Solenoid kit.
//
// Everything a surface is allowed to draw with. Three tiers, and the boundary
// between them is real: `core` knows nothing about the agent, `agent` knows
// about runs and evidence but not about layout, `mobile` is the phone's own
// vocabulary rather than the desktop's at a smaller width.
//
// Import the stylesheet once (web/src/main.tsx does) — every component styles
// itself through the tokens it defines, so a component pulled in without it
// renders unstyled rather than wrong.

export * from "./types";

// core — no knowledge of the agent
export { Badge, type BadgeTone } from "./core/Badge";
export { Button, type ButtonSize, type ButtonVariant } from "./core/Button";
export { Chip } from "./core/Chip";
export { Meter } from "./core/Meter";
export { MonoLabel } from "./core/MonoLabel";
export { Panel, type PanelTone } from "./core/Panel";
export { SectionRule } from "./core/SectionRule";
export { StatusMark } from "./core/StatusMark";
export { Tabs, type TabItem } from "./core/Tabs";

// agent — runs, traces, evidence
export { ActivityItem } from "./agent/ActivityItem";
export { ApprovalBubble, type ApprovalChoice } from "./agent/ApprovalBubble";
export { CalendarEvent } from "./agent/CalendarEvent";
export { ChatTurn } from "./agent/ChatTurn";
export { ConversationRow } from "./agent/ConversationRow";
export { Composer } from "./agent/Composer";
export {
  EvidenceBrief,
  EvidenceList,
  EvidencePanel,
  EvidenceRow,
  EvidenceSection,
  EvidenceViewer,
  type EvidenceArticleBody,
  type EvidenceEmailBody,
  type EvidenceItem,
  type EvidenceShotBody,
  type EvidenceTurn,
} from "./agent/Evidence";
export { LogStream, type LogLine } from "./agent/LogStream";
export { RailGroup } from "./agent/RailGroup";
export { RailItem } from "./agent/RailItem";
export { TimeGrid, type TimeGridDay, type TimeGridItem } from "./agent/TimeGrid";
export { ToolCalls, type ToolCall } from "./agent/ToolCalls";
export { TraceTree, type TraceNode } from "./agent/TraceTree";

// mobile — the phone's own vocabulary
export { Agenda, AgendaNow, AgendaRow } from "./mobile/Agenda";
export { AskButton } from "./mobile/AskButton";
export { AskDock } from "./mobile/AskDock";
export { DayStrip, DayStripCell, type DayStripDay } from "./mobile/DayStrip";
export { Sheet } from "./mobile/Sheet";
export { TabBar, TabBarItem, type TabBarEntry } from "./mobile/TabBar";
export { TimelineFeed, TimelineItem } from "./mobile/TimelineFeed";
