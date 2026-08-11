import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  GlobalSignOutCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  RevokeTokenCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { RuntimeConfig } from "./types.js";

export interface Tokens {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export class AuthClient {
  private readonly client: CognitoIdentityProviderClient;
  constructor(private readonly runtime: RuntimeConfig) {
    this.client = new CognitoIdentityProviderClient({
      region: runtime.region,
      endpoint: runtime.cognitoEndpoint,
      credentials: undefined,
    });
  }

  async signUp(email: string, password: string) {
    return this.client.send(new SignUpCommand({
      ClientId: this.runtime.appClientId,
      Username: email,
      Password: password,
      UserAttributes: [{ Name: "email", Value: email }],
    }));
  }

  async confirm(email: string, code: string) {
    return this.client.send(new ConfirmSignUpCommand({
      ClientId: this.runtime.appClientId,
      Username: email,
      ConfirmationCode: code,
    }));
  }

  async resend(email: string) {
    return this.client.send(new ResendConfirmationCodeCommand({
      ClientId: this.runtime.appClientId,
      Username: email,
    }));
  }

  async login(email: string, password: string): Promise<Tokens> {
    const result = await this.client.send(new InitiateAuthCommand({
      ClientId: this.runtime.appClientId,
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }));
    const auth = result.AuthenticationResult!;
    const tokens = {
      idToken: auth.IdToken!,
      accessToken: auth.AccessToken!,
      refreshToken: auth.RefreshToken,
      expiresAt: Date.now() + (auth.ExpiresIn ?? 3600) * 1000,
    };
    if (tokens.refreshToken) sessionStorage.setItem("sprintPlannerRefresh", JSON.stringify({ value: tokens.refreshToken, expiresAt: Date.now() + 7 * 86_400_000 }));
    return tokens;
  }

  async restore(): Promise<Tokens | undefined> {
    let saved: { value: string; expiresAt: number } | undefined;
    try { saved = JSON.parse(sessionStorage.getItem("sprintPlannerRefresh") ?? "null"); } catch {}
    if (!saved || saved.expiresAt <= Date.now()) return;
    const result = await this.client.send(new InitiateAuthCommand({
      ClientId: this.runtime.appClientId,
      AuthFlow: "REFRESH_TOKEN_AUTH",
      AuthParameters: { REFRESH_TOKEN: saved.value },
    }));
    const auth = result.AuthenticationResult!;
    return {
      idToken: auth.IdToken!,
      accessToken: auth.AccessToken!,
      refreshToken: saved.value,
      expiresAt: Date.now() + (auth.ExpiresIn ?? 3600) * 1000,
    };
  }

  async signOut(tokens?: Tokens) {
    try {
      if (tokens?.accessToken) await this.client.send(new GlobalSignOutCommand({ AccessToken: tokens.accessToken }));
      if (tokens?.refreshToken) await this.client.send(new RevokeTokenCommand({ ClientId: this.runtime.appClientId, Token: tokens.refreshToken }));
    } finally {
      sessionStorage.removeItem("sprintPlannerRefresh");
    }
  }
}
