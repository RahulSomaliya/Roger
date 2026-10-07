import { chatChannels, type ChatApi } from '../../shared/ipc/chat';
import { invoke, subscribe } from '../bridge';

/** Chat's part of `window.roger`. */
export const chatBridge: ChatApi = {
  getChatThread: (meetingId) => invoke(chatChannels.ChatGetThread, meetingId),
  sendChatMessage: (request) => invoke(chatChannels.ChatSend, request),
  cancelChatAnswer: (request) => invoke(chatChannels.ChatCancel, request),
  onChatEvent: (listener) => subscribe(chatChannels.ChatEvent, listener),
  onChatThreadChanged: (listener) => subscribe(chatChannels.ChatThreadChanged, listener),
};
