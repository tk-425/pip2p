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
export function formatMessage(msg: { from: string; content: string; timestamp: number }): string {
  let text = `From ${msg.from}: "${msg.content}"`;

  const skillName = detectSkillReference(msg.content);
  if (skillName) {
    text += `\n\nHint: ${msg.from} mentioned the "${skillName}" skill. `;
    text += `You can invoke it with /skill:${skillName}`;
  }

  return text;
}
