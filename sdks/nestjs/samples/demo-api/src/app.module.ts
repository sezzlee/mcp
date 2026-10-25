import { Module } from "@nestjs/common";
import { SezzleeModule } from "@sezzlee/sdk-nestjs";
import { AttachmentsController } from "./attachments.controller.js";
import { DemoAttachmentResolver } from "./attachments.js";
import { AuthController } from "./auth.controller.js";
import { DynamicMethodsController } from "./dynamic-methods.controller.js";
import { dynamicMethods, dynamicMethodsSource } from "./dynamic-methods.js";
import {
  AdminRoleGuard,
  BusinessHoursGuard,
  JwtGuard,
  OrdersReadGuard,
} from "./auth.js";
import { McpController } from "./mcp.controller.js";
import {
  demoIssuerUrl,
  demoResourceUrl,
  demoVerifier,
  DemoOAuthProvider,
} from "./oauth-provider.js";
import { OrdersController } from "./orders.controller.js";
import { NoteSummaryService, noteSummaryTool } from "./note-summary.js";

@Module({
  imports: [
    SezzleeModule.forRoot((options) => {
      options.resourceServer = {
        resource: demoResourceUrl,
        authorizationServers: [demoIssuerUrl],
        resourceName: "demo-api",
        verifier: demoVerifier,
      };
      options.visibility.tier = "probe";
      options.tools.push(noteSummaryTool);
      options.files.resolver = new DemoAttachmentResolver();
      options.families.provide(dynamicMethodsSource, () => dynamicMethods);
      if (process.env["DEMOAPI_QUERY_GROUPING"] === "group") {
        options.query.grouping = "group";
      }
    }),
  ],
  controllers: [
    AuthController,
    OrdersController,
    AttachmentsController,
    DynamicMethodsController,
    McpController,
  ],
  providers: [
    NoteSummaryService,
    DemoOAuthProvider,
    AdminRoleGuard,
    BusinessHoursGuard,
    JwtGuard,
    OrdersReadGuard,
  ],
})
export class AppModule {}
