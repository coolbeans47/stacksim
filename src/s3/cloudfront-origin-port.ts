export const CLOUDFRONT_S3_SERVICE_PRINCIPAL = "cloudfront.amazonaws.com" as const;

export interface CloudFrontS3OriginRequest {
  accountId: string;
  bucketRegion: string;
  bucketName: string;
  key: string;
  distributionArn: string;
  method: "GET" | "HEAD" | "OPTIONS";
  headers: Record<string, string>;
  maximumBytes: number;
}

export interface CloudFrontS3OriginResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  etag?: string;
  lastModified?: number;
}

/** Method-aware, policy-enforcing S3-owned origin port. */
export interface CloudFrontS3OriginPort {
  request(input: CloudFrontS3OriginRequest): Promise<CloudFrontS3OriginResponse>;
}
