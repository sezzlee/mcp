# Connect over TLS

By default the server encrypts the connection to PostgreSQL and verifies the server's certificate.
Choose a different mode for a development server, or a server whose certificate a private authority
signed.

## Choose an SSL mode

`SEZZLEE_POSTGRES_SSL_MODE` takes one of three values:

| Mode          | Encrypts | Checks the certificate | Use it for                                                              |
| ------------- | -------- | ---------------------- | ----------------------------------------------------------------------- |
| `verify-full` | yes      | yes                    | The default. Any server whose certificate chains to a public authority. |
| `require`     | yes      | no                     | A server with a self-signed or privately signed certificate.            |
| `disable`     | no       | no                     | A local server on a trusted network that has no TLS.                    |

`verify-full` checks two things: that the certificate chains to an authority Node.js trusts, and that
it names the host you put in `SEZZLEE_POSTGRES_SERVER`. Connect by the name the certificate carries.
An IP address passes only when the certificate lists that address.

Set the mode in the server's environment, next to the other connection values. For the Inspector
configuration from the [Quickstart](/docs/postgres-mcp/quickstart#see-what-the-agent-receives):

```json
{
  "mcpServers": {
    "shop": {
      "command": "sezzlee-postgres",
      "env": {
        "SEZZLEE_POSTGRES_SERVER": "db.example.com",
        "SEZZLEE_POSTGRES_DATABASE": "YourDatabase",
        "SEZZLEE_POSTGRES_USER": "your_user",
        "SEZZLEE_POSTGRES_PASSWORD": "your_password",
        "SEZZLEE_POSTGRES_SSL_MODE": "verify-full"
      }
    }
  }
}
```

Uses the `sql` helper from the [Quickstart](/docs/postgres-mcp/quickstart#see-what-the-agent-receives).
A call that needs the database shows whether the connection came up:

```sh
sql describe_connection | jq -c '{engine, dialect, sessionIntent: .readOnly.sessionIntent}'
```

```json
{"engine":"PostgreSQL","dialect":"postgres","sessionIntent":"read_only"}
```

## If the server does not offer TLS

With `require` or `verify-full`, a server that does not accept TLS fails the call with
`connection_failed`, and the recovery says so. Enable TLS on the server. Set `disable` only when the
network between the two is one you trust.

## If a private authority signed the certificate

A server whose certificate comes from an authority Node.js does not trust, such as AWS RDS, Google
Cloud SQL or your own, fails `verify-full`. The command-line server has no setting for a certificate
authority. You can set `require`, which encrypts without checking who answered, or embed the server
and pass the authority's certificates to `createPostgresSource` as `caCertificate`, PEM text holding
one or more certificates:

```ts
import { readFileSync } from "node:fs";
import { createPostgresMcpServer, createPostgresSource } from "@sezzlee/postgres-mcp";

const source = createPostgresSource({
  server: "db.internal.example.com",
  port: 5432,
  database: "sales",
  user: "mcp_reader",
  password: "your_password",
  sslMode: "verify-full",
  caCertificate: readFileSync("/etc/ssl/private-ca.pem", "utf8"),
  connectTimeoutMs: 30000,
  queryTimeoutMs: 30000,
});
const server = createPostgresMcpServer(source);
```

`createPostgresMcpServer` returns an MCP server for you to connect to a transport. Every field except
`caCertificate` is required when you embed. With `caCertificate` set, the server's certificate must
chain to one of those authorities instead of Node.js's own list, and the host name is still checked.

:::details[Why require is not a middle ground]

`require` keeps the traffic private from someone who only listens. It does not stop someone who sits
between the server and the database from answering with a certificate of their own, because the
server then accepts any certificate, and they would read every query and result. Use it to get a
private-authority server working, then move to `verify-full` with `caCertificate` once you embed.

:::
