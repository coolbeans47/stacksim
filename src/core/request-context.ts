export interface AwsRequestContext {
  requestId: string;
  service: string;
  operation: string;
  region: string;
  accountId: string;
  requestTime: Date;
  sourceIp?: string;
  userAgent?: string;
  deliveryLineage?: string[];
  credentials?: { accessKeyId: string; sessionToken?: string; principalArn: string; sessionArn?: string };
}
