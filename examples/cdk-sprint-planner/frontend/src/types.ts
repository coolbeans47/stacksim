export interface RuntimeConfig {
  schemaVersion: 1;
  region: string;
  cognitoEndpoint: string;
  userPoolId: string;
  appClientId: string;
  issuer: string;
  apiBaseUrl: string;
  websocketUrl: string;
}

export interface Ticket {
  ticketKey: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  sprintId: string | null;
  status: "BACKLOG" | "TODO" | "IN_PROGRESS" | "REVIEW" | "DONE";
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  storyPoints: number;
  assigneeMemberId: string | null;
  rank: number;
  rankKey: string;
  version: number;
}

export interface Lane {
  status: Ticket["status"];
  version: number;
  tickets: Ticket[];
}

export interface Session {
  membership: { memberId: string; displayName: string; email: string; role: "ADMIN" | "MEMBER"; status: string };
  permissions: { administer: boolean; createTickets: boolean; manageTeam: boolean };
  workspace: { workspaceId: string; name: string };
  activeSprint: { sprintId: string; name: string; goal: string; startDate: string; endDate: string; openTicketCount: number; version: number };
}

declare global {
  const __SPRINT_PLANNER_RUNTIME__: RuntimeConfig;
}
