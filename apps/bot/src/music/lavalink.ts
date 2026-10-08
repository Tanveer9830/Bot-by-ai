import { WebSocket } from 'ws';
import type { Logger } from '@bot-by-ai/shared';

/**
 * Minimal, dependency-light Lavalink v4 client.
 *
 * Only the surface the bot actually uses is implemented: session handshake,
 * player state updates, track loading, and the gateway events needed for queue
 * progression (TrackStart / TrackEnd / TrackException / WebSocketClosed).
 */
export interface LavalinkNodeConfig {
  host: string;
  port: number;
  password: string;
  secure: boolean;
  clientName?: string;
}

export interface LavalinkTrack {
  encoded: string;
  info: {
    identifier: string;
    author: string;
    title: string;
    length: number;
    uri?: string;
    artworkUrl?: string;
    isStream: boolean;
    sourceName: string;
  };
  pluginInfo?: Record<string, unknown>;
}

export interface LavalinkPlayerState {
  guildId: string;
  track: LavalinkTrack | null;
  positionMs: number;
  paused: boolean;
  volume: number;
  connected: boolean;
  channelId: string | null;
}

export interface LoadTracksResult {
  loadType: 'track' | 'playlist' | 'search' | 'empty' | 'error';
  tracks: LavalinkTrack[];
  playlistName?: string;
  exception?: { message?: string; severity?: string };
}

export type LavalinkEventHandler = (payload: Record<string, unknown>) => void;

export class LavalinkNode {
  readonly name: string;
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly pending = new Map<string, (payload: Record<string, unknown>) => void>();
  private handlers: LavalinkEventHandler[] = [];
  private reconnectAttempts = 0;
  private closedByUser = false;
  private heartbeat: NodeJS.Timeout | null = null;
  public stats: Record<string, unknown> | null = null;

  constructor(
    private readonly config: LavalinkNodeConfig,
    private readonly clientId: string,
    private readonly logger: Logger,
  ) {
    this.name = `${config.host}:${config.port}`;
    const protocol = config.secure ? 'https' : 'http';
    const wsProtocol = config.secure ? 'wss' : 'ws';
    this.baseUrl = `${protocol}://${config.host}:${config.port}`;
    this.wsUrl = `${wsProtocol}://${config.host}:${config.port}/v4/websocket`;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== null;
  }

  get session(): string | null {
    return this.sessionId;
  }

  onEvent(handler: LavalinkEventHandler): void {
    this.handlers.push(handler);
  }

  async connect(userId: string): Promise<void> {
    this.closedByUser = false;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl, {
        headers: {
          Authorization: this.config.password,
          'User-Id': userId,
          'Client-Name': this.config.clientName ?? 'bot-by-ai/1.0.0',
        },
      });
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error('Lavalink connection timed out'));
      }, 10_000);

      socket.on('open', () => {
        this.logger.info('lavalink socket open', { node: this.name });
      });
      socket.on('message', (data: Buffer) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(data.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        const op = payload.op as string | undefined;
        if (op === 'ready') {
          this.sessionId = String(payload.sessionId);
          this.reconnectAttempts = 0;
          clearTimeout(timeout);
          this.startHeartbeat();
          resolve();
          return;
        }
        if (op === 'stats') {
          this.stats = (payload as { players?: number }).players !== undefined ? payload : payload;
          return;
        }
        if (op === 'event') {
          for (const handler of this.handlers) handler(payload);
          return;
        }
        if (op === 'playerUpdate') {
          const key = `player:${String(payload.guildId)}`;
          const resolver = this.pending.get(key);
          if (resolver) {
            this.pending.delete(key);
            resolver(payload);
          }
          return;
        }
      });
      socket.on('error', (error: Error) => {
        this.logger.warn('lavalink socket error', { node: this.name, error: error.message });
      });
      socket.on('close', (code: number) => {
        clearTimeout(timeout);
        this.ws = null;
        this.sessionId = null;
        this.stopHeartbeat();
        if (this.closedByUser) return;
        this.logger.warn('lavalink socket closed, scheduling reconnect', { node: this.name, code });
        this.scheduleReconnect(userId);
      });
      this.ws = socket;
    });
  }

  private scheduleReconnect(userId: string): void {
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 2_000 * 2 ** (this.reconnectAttempts - 1));
    setTimeout(() => {
      if (this.closedByUser) return;
      this.connect(userId).catch((error) =>
        this.logger.error('lavalink reconnect failed', {
          node: this.name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      void this.request('GET', '/v4/players').catch(() => {});
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  disconnect(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.sessionId = null;
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.config.password,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status === 204) return {};
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `Lavalink ${method} ${path} failed with ${response.status}: ${text.slice(0, 200)}`,
        );
      }
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } finally {
      clearTimeout(timeout);
    }
  }

  async loadTracks(identifier: string): Promise<LoadTracksResult> {
    const result = await this.request(
      'GET',
      `/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`,
    );
    const loadType = (result.loadType as LoadTracksResult['loadType']) ?? 'empty';
    if (loadType === 'playlist') {
      const data = result.data as
        { tracks?: LavalinkTrack[]; info?: { name?: string } } | undefined;
      return { loadType, tracks: data?.tracks ?? [], playlistName: data?.info?.name };
    }
    if (loadType === 'track') {
      return { loadType, tracks: result.data ? [result.data as LavalinkTrack] : [] };
    }
    if (loadType === 'search') {
      return { loadType, tracks: (result.data as LavalinkTrack[]) ?? [] };
    }
    if (loadType === 'error') {
      return {
        loadType,
        tracks: [],
        exception: result.data as { message?: string; severity?: string } | undefined,
      };
    }
    return { loadType: 'empty', tracks: [] };
  }

  async updatePlayer(
    guildId: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.sessionId) throw new Error('Lavalink session is not ready');
    return this.request('PATCH', `/v4/sessions/${this.sessionId}/players/${guildId}`, payload);
  }

  async destroyPlayer(guildId: string): Promise<void> {
    if (!this.sessionId) return;
    await this.request('DELETE', `/v4/sessions/${this.sessionId}/players/${guildId}`).catch(
      () => {},
    );
  }

  async decodeTracks(encoded: string[]): Promise<LavalinkTrack[]> {
    if (encoded.length === 0) return [];
    const result = await this.request('POST', '/v4/decodetracks', encoded);
    return Array.isArray(result) ? (result as LavalinkTrack[]) : [];
  }
}
