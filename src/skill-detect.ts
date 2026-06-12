/**
 * Skill Detection - detects skill references in message content
 */

const SKILL_PATTERNS = [
  /run\s+(\S+)\s+skill/i,
  /use\s+(\S+)\s+skill/i,
  /invoke\s+(\S+)\s+skill/i,
  /\/skill:(\S+)/,
  /skill\s*:\s*(\S+)/i,
];

/**
 * Detect if a message content references a skill
 */
export function detectSkillReference(content: string): string | null {
  for (const pattern of SKILL_PATTERNS) {
    const match = content.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Format a message for display, including skill hints
 */
export function formatMessage(msg: {
  from: string;
  content: string;
  timestamp: number;
  type?: string;
  approvalRequest?: {
    requestId: string;
    actionType: string;
    title: string;
    summary: string;
    details?: string;
    commands?: string[];
    files?: string[];
  };
  approvalDecision?: {
    requestId: string;
    decision: "approved" | "rejected";
    note?: string;
  };
}): string {
  if (msg.type === "approval-request" && msg.approvalRequest) {
    let text = `Approval request from ${msg.from}: ${msg.approvalRequest.title}\n`;
    text += `Request ID: ${msg.approvalRequest.requestId}\n`;
    text += `Action: ${msg.approvalRequest.actionType}\n`;
    text += `Summary: ${msg.approvalRequest.summary}`;
    if (msg.approvalRequest.details) {
      text += `\n\nDetails:\n${msg.approvalRequest.details}`;
    }
    if (msg.approvalRequest.commands?.length) {
      text += `\n\nCommands:\n${msg.approvalRequest.commands.map((command) => `- ${command}`).join("\n")}`;
    }
    if (msg.approvalRequest.files?.length) {
      text += `\n\nFiles:\n${msg.approvalRequest.files.map((file) => `- ${file}`).join("\n")}`;
    }
    return text;
  }

  if (msg.type === "approval-decision" && msg.approvalDecision) {
    return `Approval decision from ${msg.from}: ${msg.approvalDecision.decision} for request ${msg.approvalDecision.requestId}${msg.approvalDecision.note ? `\nNote: ${msg.approvalDecision.note}` : ""}`;
  }

  let text = `From ${msg.from}: "${msg.content}"`;

  const skillName = detectSkillReference(msg.content);
  if (skillName) {
    text += `\n\nHint: ${msg.from} mentioned the "${skillName}" skill. `;
    text += `You can invoke it with /skill:${skillName}`;
  }

  return text;
}
