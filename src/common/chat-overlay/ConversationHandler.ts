import { bareBonesPromptMixer } from '~/modules/persona/pmix/pmix';

import { SystemPurposes } from '../../data';
import { gcChatImageAssets } from '../../apps/chat/editors/image-generate';

import { createBeamVanillaStore } from '~/modules/beam/store-beam-vanilla';

import type { DConversationId } from '~/common/stores/chat/chat.conversation';
import type { DLLMId } from '~/common/stores/llms/llms.types';
import { ChatActions, getConversationSystemPurposeId, useChatStore } from '~/common/stores/chat/store-chats';
import { createDMessageEmpty, createDMessageFromFragments, createDMessagePlaceholderIncomplete, createDMessageTextContent, DMessage, DMessageId, MESSAGE_FLAG_VND_ANT_CACHE_AUTO, MESSAGE_FLAG_VND_ANT_CACHE_USER, messageHasUserFlag, messageSetUserFlag } from '~/common/stores/chat/chat.message';
import { createTextContentFragment, DMessageFragment, DMessageFragmentId } from '~/common/stores/chat/chat.fragments';
import { getChatLLMId } from '~/common/stores/llms/store-llms';

import { getChatAutoAI } from '../../apps/chat/store-app-chat';

import { createDEphemeral } from './store-ephemeralsoverlay-slice';
import { createPerChatVanillaStore } from './store-chat-overlay';


/**
 * ConversationHandler is a class to overlay state onto a conversation.
 * It is a singleton per conversationId.
 *  - View classes will react to this class (or its members) to update the UI.
 *  - Controller classes will call directly methods in this class.
 */
export class ConversationHandler {
  private readonly chatActions: ChatActions;
  private readonly conversationId: DConversationId;

  private readonly beamStore = createBeamVanillaStore();
  private readonly overlayStore = createPerChatVanillaStore();

  constructor(conversationId: DConversationId) {
    this.chatActions = useChatStore.getState();
    this.conversationId = conversationId;
  }


  // Conversation Management

  static inlineUpdatePurposeInHistory(conversationId: DConversationId, history: DMessage[], assistantLlmId: DLLMId | undefined): void {
    const purposeId = getConversationSystemPurposeId(conversationId);
    // TODO: HACK: find the persona identiy separately from the "first system message"
    const systemMessageIndex = history.findIndex(m => m.role === 'system');

    let systemMessage: DMessage = systemMessageIndex >= 0
      ? history.splice(systemMessageIndex, 1)[0]
      : createDMessageEmpty('system'); // [chat] new system:'' (non updated)

    // TODO: move this to a proper persona identity management
    // Update the system message with the current persona's message, if formerly unset
    if (!systemMessage.updated && purposeId && SystemPurposes[purposeId]?.systemMessage) {
      systemMessage.purposeId = purposeId;
      const systemMessageText = bareBonesPromptMixer(SystemPurposes[purposeId].systemMessage, assistantLlmId);
      systemMessage.fragments = [createTextContentFragment(systemMessageText)];

      // HACK: this is a special case for the 'Custom' persona, to set the message in stone (so it doesn't get updated when switching to another persona)
      if (purposeId === 'Custom')
        systemMessage.updated = Date.now();

      // HACK: refresh the object to trigger a re-render of this message
      systemMessage = { ...systemMessage };
    }

    history.unshift(systemMessage);
  }

  static inlineUpdateAutoPromptCaching(history: DMessage[]): void {
    const setAuto = getChatAutoAI().autoVndAntBreakpoints;

    // update the auto flag on the last two user messages, or remove it if disabled
    let breakpointsRemaining = 2;
    for (let i = history.length - 1; i >= 0; i--) {

      // when disabled: remove prior auto flags if set
      if (!setAuto) {
        if (messageHasUserFlag(history[i], MESSAGE_FLAG_VND_ANT_CACHE_AUTO))
          history[i] = { ...history[i], userFlags: messageSetUserFlag(history[i], MESSAGE_FLAG_VND_ANT_CACHE_AUTO, false) };
        continue;
      }

      // when enabled: set the auto flag on the last two user messages
      const isSystemInstruction = history[i].role === 'system' && i === 0;
      if (!isSystemInstruction && history[i].role !== 'user')
        continue;

      // set the auto flag on the last two user messages, unless the user flag is set on any, and reset the flag on the others
      let autoState = --breakpointsRemaining >= 0 || isSystemInstruction;
      if (autoState && messageHasUserFlag(history[i], MESSAGE_FLAG_VND_ANT_CACHE_USER))
        autoState = false;
      if (autoState !== messageHasUserFlag(history[i], MESSAGE_FLAG_VND_ANT_CACHE_AUTO))
        history[i] = { ...history[i], userFlags: messageSetUserFlag(history[i], MESSAGE_FLAG_VND_ANT_CACHE_AUTO, autoState) };
    }
  }

  setAbortController(abortController: AbortController | null): void {
    this.chatActions.setAbortController(this.conversationId, abortController);
  }


  // Message Management

  /**
   * @param text assistant text
   * @param llmLabel LlmId or string, such as 'DALL·E' | 'Prodia' | 'react-...' | 'web'
   */
  messageAppendAssistantText(text: string, llmLabel: DLLMId | string) {
    const message = createDMessageTextContent('assistant', text);
    message.originLLM = llmLabel;
    this.messageAppend(message);
  }

  messageAppendAssistantPlaceholder(placeholderText: string, update?: Partial<DMessage>): { assistantMessageId: DMessageId, placeholderFragmentId: DMessageFragmentId } {
    const message = createDMessagePlaceholderIncomplete('assistant', placeholderText);
    if (update)
      Object.assign(message, update);
    this.messageAppend(message);
    return { assistantMessageId: message.id, placeholderFragmentId: message.fragments[0].fId };
  }

  messageAppend(message: DMessage) {
    this.chatActions.appendMessage(this.conversationId, message);
  }

  messageEdit(messageId: string, update: Partial<DMessage> | ((message: DMessage) => Partial<DMessage>), messageComplete: boolean, touch: boolean) {
    this.chatActions.editMessage(this.conversationId, messageId, update, messageComplete, touch);
  }

  messagesDelete(messageIds: DMessageId[]): void {
    for (const messageId of messageIds)
      this.chatActions.deleteMessage(this.conversationId, messageId);
    void gcChatImageAssets(); // fire/forget
  }

  messageFragmentAppend(messageId: string, fragment: DMessageFragment, complete: boolean, touch: boolean) {
    this.chatActions.appendMessageFragment(this.conversationId, messageId, fragment, complete, touch);
  }

  messageFragmentDelete(messageId: string, fragmentId: string, complete: boolean, touch: boolean) {
    this.chatActions.deleteMessageFragment(this.conversationId, messageId, fragmentId, complete, touch);
  }

  messageFragmentReplace(messageId: string, fragmentId: string, newFragment: DMessageFragment, messageComplete: boolean) {
    this.chatActions.replaceMessageFragment(this.conversationId, messageId, fragmentId, newFragment, messageComplete, true);
  }

  historyClear(): void {
    this.historyReplace([]);
  }

  historyReplace(messages: DMessage[]): void {
    this.chatActions.historyReplace(this.conversationId, messages);

    void gcChatImageAssets(); // fire/forget

    // if zeroing the messages, also terminate an active beam
    if (!messages.length)
      this.beamStore.getState().terminateKeepingSettings();
  }

  historyTruncateTo(messageId: DMessageId, offset: number = 0): void {
    this.chatActions.historyTruncateToIncluded(this.conversationId, messageId, offset);
  }

  historyViewHead(scope: string): Readonly<DMessage[]> {
    const messages = this.chatActions.historyView(this.conversationId);
    if (messages === undefined)
      throw new Error(`allMessages: Conversation not found, ${scope}`);
    return messages;
  }


  // Beam

  getBeamStore = () => this.beamStore;

  /**
   * Opens a beam over the given history
   *
   * @param viewHistory The history up to the point where the beam is invoked
   * @param importMessages If set, any message to import into the beam as pre-set rays
   * @param destReplaceMessageId If set, the output will replace the message with this id, otherwise it will append to the history
   */
  beamInvoke(viewHistory: Readonly<DMessage[]>, importMessages: DMessage[], destReplaceMessageId: DMessage['id'] | null): void {
    const { open: beamOpen, importRays: beamImportRays, terminateKeepingSettings } = this.beamStore.getState();

    const onBeamSuccess = (fragments: DMessageFragment[], llmId: DLLMId) => {
      // set output when going back to the chat
      if (destReplaceMessageId) {
        // replace a single message in the conversation history
        this.messageEdit(destReplaceMessageId, { fragments, originLLM: llmId }, true, true); // [chat] replace assistant:Beam contentParts
      } else {
        // replace (may truncate) the conversation history and append a message
        const newMessage = createDMessageFromFragments('assistant', fragments); // [chat] append Beam message
        newMessage.originLLM = llmId;
        newMessage.purposeId = getConversationSystemPurposeId(this.conversationId) ?? undefined;
        // TODO: put the other rays in the metadata?! (reqby @Techfren)
        this.messageAppend(newMessage);
      }

      // close beam
      terminateKeepingSettings();
    };

    beamOpen(viewHistory, getChatLLMId(), onBeamSuccess);
    importMessages.length && beamImportRays(importMessages, getChatLLMId());
  }


  // Ephemerals

  createEphemeralHandler(title: string, initialText: string) {
    const { ephemeralsAppend, ephemeralsUpdate, ephemeralsDelete, ephemeralsIsPinned } = this.overlayActions;

    // create and append
    const ephemeral = createDEphemeral(title, initialText);
    const eId = ephemeral.id;
    ephemeralsAppend(ephemeral);

    // return a 'handler' (manipulation functions)
    return {
      updateText: (text: string) => ephemeralsUpdate(eId, { text }),
      updateState: (state: object) => ephemeralsUpdate(eId, { state }),
      markAsDone: () => ephemeralsUpdate(eId, { done: true }),
      deleteIfNotPinned: () => {
        if (!ephemeralsIsPinned(eId))
          ephemeralsDelete(eId);
      },
    };
  }


  // Overlay Store

  get conversationOverlayStore() {
    return this.overlayStore;
  }

  get overlayActions() {
    return this.overlayStore.getState();
  }

}
