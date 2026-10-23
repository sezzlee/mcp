import { All, Controller, Req, Res } from "@nestjs/common";
import {
  SezzleeMcpEndpoint,
  type SezzleeRequestHandler,
} from "@sezzlee/sdk-nestjs";
import type { Request, Response } from "express";

@Controller()
export class McpController {
  private readonly serve: SezzleeRequestHandler;

  constructor(endpoint: SezzleeMcpEndpoint) {
    this.serve = endpoint.serve({ name: "demo-api", version: "0.0.0" });
  }

  @All("mcp")
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.serve(req, res);
  }
}
