export interface StoreChannel {
  id: string;
  name: string;
  teamId: string;
  enabled: boolean;
  webhookUrl: string;
  autoApproveUsers: string[];
  metadataSchema: string;
  createdAt: string;
}

export interface StoreMessage {
  id?: number;
  slackTs: string;
  channelId: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
  metadata: any;
}

export interface Store {
  getChannel(id: string): Promise<StoreChannel | null>;
  upsertChannel(ch: StoreChannel): Promise<void>;
  listEnabledChannels(): Promise<StoreChannel[]>;
  upsertMessage(msg: StoreMessage): Promise<void>;
  getMessages(channelId: string, limit?: number, offset?: number): Promise<StoreMessage[]>;
  close(): void;
}
