export type BridgePromptSource = 'im' | 'card' | 'comment';

export interface BridgePromptMention {
  openId?: string;
  name?: string;
  isBot?: boolean;
}

export interface BridgePromptContext {
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  /** Whether the sender is a human user or another bot ('app' sender). */
  senderType?: 'user' | 'bot';
  /** The bridge bot's own open_id — "this id is you" for self-identification. */
  botOpenId?: string;
  /** Accounts @-mentioned in the triggering message(s), deduped across the batch. */
  mentions?: BridgePromptMention[];
  threadId?: string;
  messageIds?: string[];
  source: BridgePromptSource;
}

export interface BridgePromptQuotedMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptInteractiveCard {
  messageId?: string;
  content: unknown;
}

/**
 * A prior message in the same Feishu topic, supplied as read-only context when
 * the bot is first pulled into a topic it hasn't been part of. Distinct from
 * `quotedMessages` (an explicit reply-quote): this is the topic's upstream
 * conversation the bot would otherwise be blind to.
 */
export interface BridgePromptTopicMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  senderType?: 'user' | 'bot';
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptComment {
  commentScopeId: string;
  isWholeDocument: boolean;
  docsLink?: string;
  question: string;
  quote?: string;
}

export interface BridgePromptAttachment {
  path: string;
  kind: string;
  hash?: string;
  size?: number;
  mime?: string;
  sourceMessageId?: string;
  requiredness?: 'required' | 'optional';
  decision?: 'accepted' | 'rejected' | 'skipped';
  rejectionReason?: string;
}

export interface BuildAgentPromptInput {
  context: BridgePromptContext;
  instructions?: string[];
  userInput: string;
  topicContext?: BridgePromptTopicMessage[];
  quotedMessages?: BridgePromptQuotedMessage[];
  interactiveCards?: BridgePromptInteractiveCard[];
  comment?: BridgePromptComment;
  attachments?: BridgePromptAttachment[];
}

export function buildAgentPrompt(input: BuildAgentPromptInput): string {
  const sections = [
    promptSection('bridge_context', input.context),
    input.instructions && input.instructions.length > 0
      ? promptSection('bridge_instructions', input.instructions)
      : undefined,
    input.topicContext && input.topicContext.length > 0
      ? promptSection('topic_context', input.topicContext)
      : undefined,
    input.quotedMessages && input.quotedMessages.length > 0
      ? promptSection('quoted_messages', input.quotedMessages)
      : undefined,
    input.interactiveCards && input.interactiveCards.length > 0
      ? promptSection('interactive_cards', input.interactiveCards)
      : undefined,
    input.comment ? promptSection('comment_context', input.comment) : undefined,
    promptSection('user_input', {
      text: input.userInput,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    }),
  ];

  return sections.filter(Boolean).join('\n\n');
}

export function promptSection(tag: string, value: unknown): string {
  return `<${tag}>\n${safeJsonStringify(value)}\n</${tag}>`;
}

/**
 * Read a section back out of a built prompt — the inverse of
 * {@link promptSection}.
 *
 * Needed because the bridge wraps its system prompt around the user's turn
 * before handing it to the agent, so anything that wants "what did the user
 * actually ask" (a `/resume` preview, a session title) must unwrap it.
 * Returns undefined when the section is absent or its payload is not the JSON
 * we wrote, so a malformed prompt degrades to "unknown" rather than throwing.
 */
export function readPromptSection(prompt: string, tag: string): unknown {
  const start = prompt.indexOf(`<${tag}>`);
  if (start === -1) return undefined;
  const bodyStart = start + tag.length + 2;
  const end = prompt.indexOf(`\n</${tag}>`, bodyStart);
  if (end === -1) return undefined;
  try {
    return JSON.parse(prompt.slice(bodyStart, end)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort one-line summary of the user's own message in a built prompt.
 *
 * Used as the `/resume` preview: mcode titles a session from its first user
 * message, but that message here is the bridge system prompt plus the request,
 * and mcode truncates the title to ~50 characters — far shorter than the system
 * prompt — so the title never contains what the user asked. The bridge's own
 * record is the only reliable source.
 */
export function summarizeUserMessage(prompt: string, maxChars = 80): string | undefined {
  const section = readPromptSection(prompt, 'user_input') as { text?: unknown } | undefined;
  const text = typeof section?.text === 'string' ? section.text.trim() : '';
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, ' ');
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

export function safeJsonStringify(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
