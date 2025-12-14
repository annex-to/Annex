/**
 * Type declarations for irc-framework
 * https://github.com/kiwiirc/irc-framework
 */

declare module "irc-framework" {
  import { EventEmitter } from "events";

  interface ConnectionOptions {
    host: string;
    port?: number;
    nick: string;
    username?: string;
    gecos?: string;
    encoding?: string;
    tls?: boolean;
    rejectUnauthorized?: boolean;
    auto_reconnect?: boolean;
    auto_reconnect_wait?: number;
    auto_reconnect_max_retries?: number;
    ping_interval?: number;
    ping_timeout?: number;
    password?: string;
    sasl_mechanism?: string;
  }

  interface MessageEvent {
    nick: string;
    ident: string;
    hostname: string;
    target: string;
    message: string;
    tags: Record<string, string>;
    reply: (message: string) => void;
  }

  interface JoinEvent {
    nick: string;
    ident: string;
    hostname: string;
    channel: string;
    time?: number;
  }

  interface PartEvent {
    nick: string;
    ident: string;
    hostname: string;
    channel: string;
    message: string;
  }

  interface QuitEvent {
    nick: string;
    ident: string;
    hostname: string;
    message: string;
  }

  interface KickEvent {
    nick: string;
    ident: string;
    hostname: string;
    channel: string;
    kicked: string;
    message: string;
  }

  interface NickEvent {
    nick: string;
    ident: string;
    hostname: string;
    new_nick: string;
  }

  interface ErrorEvent {
    error: string;
    reason?: string;
  }

  interface Channel {
    name: string;
    say: (message: string) => void;
    notice: (message: string) => void;
    part: (message?: string) => void;
    join: (key?: string) => void;
    users: User[];
  }

  interface User {
    nick: string;
    modes: string[];
    away?: boolean;
  }

  class Client extends EventEmitter {
    constructor();

    connect(options: ConnectionOptions): void;
    quit(message?: string): void;
    join(channel: string, key?: string): void;
    part(channel: string, message?: string): void;
    say(target: string, message: string): void;
    notice(target: string, message: string): void;
    action(target: string, message: string): void;
    ctcpRequest(target: string, type: string, ...params: string[]): void;
    ctcpResponse(target: string, type: string, ...params: string[]): void;
    whois(nick: string): void;
    who(target: string): void;
    raw(command: string): void;
    changeNick(nick: string): void;

    on(event: "registered", listener: () => void): this;
    on(event: "connected", listener: () => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "socket close", listener: () => void): this;
    on(event: "reconnecting", listener: () => void): this;
    on(event: "message", listener: (event: MessageEvent) => void): this;
    on(event: "privmsg", listener: (event: MessageEvent) => void): this;
    on(event: "notice", listener: (event: MessageEvent) => void): this;
    on(event: "action", listener: (event: MessageEvent) => void): this;
    on(event: "join", listener: (event: JoinEvent) => void): this;
    on(event: "part", listener: (event: PartEvent) => void): this;
    on(event: "quit", listener: (event: QuitEvent) => void): this;
    on(event: "kick", listener: (event: KickEvent) => void): this;
    on(event: "nick", listener: (event: NickEvent) => void): this;
    on(event: "error", listener: (event: ErrorEvent) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;

    channel(name: string): Channel | undefined;
    user: {
      nick: string;
      modes: string[];
    };
  }

  export { Client, ConnectionOptions, MessageEvent, JoinEvent, Channel, User };
}
