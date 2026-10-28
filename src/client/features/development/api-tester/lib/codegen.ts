// Multi-language HTTP request code generator.
// Pure TypeScript: no React or DOM dependency, usable in browsers and Workers.

export interface CodegenRequest {
  method: string; // GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS
  url: string; // absolute URL
  headers: Array<{ key: string; value: string; enabled: boolean }>;
  queryParams: Array<{ key: string; value: string; enabled: boolean }>;
  body: string; // request body text (JSON/XML/raw)
  // `binary` is an extension for this port: the bytes live outside the generated text, so the
  // output carries a comment instead of a body literal.
  bodyType: "none" | "json" | "xml" | "raw" | "form-data" | "x-www-form-urlencoded" | "binary";
  auth?: {
    type: "none" | "bearer" | "basic" | "apikey_header" | "apikey_query";
    token?: string; // bearer token
    username?: string; // basic auth
    password?: string; // basic auth
    keyName?: string; // API key header/query name
    keyValue?: string; // API key value
  };
}

export interface CodegenLanguage {
  id: string; // stable id, e.g. 'curl'
  label: string; // display name, e.g. 'cURL'
  category: string; // grouping in the language picker
  generate: (req: CodegenRequest) => string;
}

// ===== Helpers =====

// Self-contained UTF-8 safe base64 encoder; avoids btoa so browsers and Workers agree.
function base64Encode(s: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new TextEncoder().encode(s);
  let result = "";
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    const b2 = i < bytes.length ? bytes[i++] : -1;
    const b3 = i < bytes.length ? bytes[i++] : -1;
    result += chars[b1 >> 2];
    result += chars[((b1 & 0x03) << 4) | (b2 >= 0 ? b2 >> 4 : 0)];
    result += b2 >= 0 ? chars[((b2 & 0x0f) << 2) | (b3 >= 0 ? b3 >> 6 : 0)] : "=";
    result += b3 >= 0 ? chars[b3 & 0x3f] : "=";
  }
  return result;
}

// Append query parameters, including apikey_query auth.
function buildUrl(req: CodegenRequest): string {
  const params: Array<{ key: string; value: string }> = [];
  for (const p of req.queryParams) {
    if (p.enabled) {
      params.push({ key: p.key, value: p.value });
    }
  }
  if (req.auth && req.auth.type === "apikey_query" && req.auth.keyName && req.auth.keyValue) {
    params.push({ key: req.auth.keyName, value: req.auth.keyValue });
  }
  if (params.length === 0) {
    return req.url;
  }
  const query = params
    .map((p) => encodeURIComponent(p.key) + "=" + encodeURIComponent(p.value))
    .join("&");
  const separator = req.url.includes("?") ? (req.url.endsWith("?") ? "" : "&") : "?";
  return req.url + separator + query;
}

// Merge custom headers with auth headers; add Content-Type for a JSON body.
function buildHeaders(req: CodegenRequest): Array<{ key: string; value: string }> {
  const map = new Map<string, { key: string; value: string }>();
  for (const h of req.headers) {
    if (h.enabled) {
      map.set(h.key.toLowerCase(), { key: h.key, value: h.value });
    }
  }
  if (req.auth) {
    if (req.auth.type === "bearer" && req.auth.token) {
      map.set("authorization", { key: "Authorization", value: "Bearer " + req.auth.token });
    } else if (req.auth.type === "basic" && req.auth.username !== undefined) {
      const encoded = base64Encode(req.auth.username + ":" + (req.auth.password || ""));
      map.set("authorization", { key: "Authorization", value: "Basic " + encoded });
    } else if (req.auth.type === "apikey_header" && req.auth.keyName && req.auth.keyValue) {
      map.set(req.auth.keyName.toLowerCase(), { key: req.auth.keyName, value: req.auth.keyValue });
    }
  }
  if (req.bodyType === "json" && req.body && !map.has("content-type")) {
    map.set("content-type", { key: "Content-Type", value: "application/json" });
  }
  return Array.from(map.values());
}

// Escape a double-quoted string (JS/Java/C#/Rust/Swift/Kotlin/Dart/Clojure/Go/Python).
function escapeDoubleQuoted(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

// Return a complete string literal (including quotes) for the target language.
function escapeString(s: string, lang: string): string {
  switch (lang) {
    case "curl":
    case "httpie":
    case "wget":
      // Shell single quotes: escape ' as '\''.
      return "'" + s.replace(/'/g, "'\\''") + "'";
    case "php-curl":
    case "php-guzzle":
      // PHP single quotes: escape \ as \\ and ' as \'.
      return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    case "ruby-nethttp":
      // Ruby single quotes: escape \ as \\ and ' as \'.
      return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    case "go":
      // Go prefers raw backtick strings; fall back to a double-quoted string when it contains one.
      if (s.indexOf("`") === -1) {
        return "`" + s + "`";
      }
      return '"' + escapeDoubleQuoted(s) + '"';
    case "python-requests":
    case "python-httpx":
      return '"' + escapeDoubleQuoted(s) + '"';
    default:
      // javascript-fetch / javascript-axios / node-http / java-* / rust-reqwest
      // csharp-httpclient / swift-urlsession / kotlin-okhttp / dart-http / clojure-cljhttp
      return '"' + escapeDoubleQuoted(s) + '"';
  }
}

// Resolve Content-Type: the caller's header wins, otherwise infer from bodyType.
function resolveContentType(
  headers: Array<{ key: string; value: string }>,
  req: CodegenRequest
): string {
  for (const h of headers) {
    if (h.key.toLowerCase() === "content-type") {
      return h.value;
    }
  }
  switch (req.bodyType) {
    case "json":
      return "application/json";
    case "xml":
      return "application/xml";
    case "x-www-form-urlencoded":
      return "application/x-www-form-urlencoded";
    case "form-data":
      return "multipart/form-data";
    case "raw":
      return "text/plain";
    case "binary":
      return "application/octet-stream";
    default:
      return "text/plain";
  }
}

function hasBody(req: CodegenRequest): boolean {
  return req.bodyType !== "none" && req.bodyType !== "binary" && !!req.body;
}

// Binary payloads cannot be embedded as text; each language gets a valid comment instead.
function binaryNotice(langId: string): string {
  const prefix =
    langId === "clojure-cljhttp"
      ? ";;"
      : langId === "curl" ||
          langId === "httpie" ||
          langId === "wget" ||
          langId === "python-requests" ||
          langId === "python-httpx" ||
          langId === "ruby-nethttp" ||
          langId === "php-curl" ||
          langId === "php-guzzle"
        ? "#"
        : "//";
  return prefix + " Binary request body is not included in the generated code.";
}

// ===== Language generators =====

export const CODEGEN_LANGUAGES: CodegenLanguage[] = [
  // 1. cURL
  {
    id: "curl",
    label: "cURL",
    category: "Shell",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lines: string[] = [];
      lines.push("curl --location " + escapeString(url, "curl"));
      if (method !== "GET") {
        lines.push("  --request " + escapeString(method, "curl"));
      }
      for (const h of headers) {
        lines.push("  --header " + escapeString(h.key + ": " + h.value, "curl"));
      }
      if (hasBody(req)) {
        lines.push("  --data " + escapeString(req.body, "curl"));
      }
      return lines.join(" \\\n");
    },
  },
  // 2. HTTPie
  {
    id: "httpie",
    label: "HTTPie",
    category: "Shell",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lines: string[] = [];
      lines.push("http --follow " + method + " " + escapeString(url, "httpie"));
      for (const h of headers) {
        lines.push("  " + escapeString(h.key + ":" + h.value, "httpie"));
      }
      if (hasBody(req)) {
        lines.push("  --raw " + escapeString(req.body, "httpie"));
      }
      return lines.join(" \\\n");
    },
  },
  // 3. Wget
  {
    id: "wget",
    label: "Wget",
    category: "Shell",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lines: string[] = [];
      lines.push("wget --method=" + method);
      for (const h of headers) {
        lines.push("  --header=" + escapeString(h.key + ": " + h.value, "wget"));
      }
      if (hasBody(req)) {
        lines.push("  --body-data=" + escapeString(req.body, "wget"));
      }
      lines.push("  -O - " + escapeString(url, "wget"));
      return lines.join(" \\\n");
    },
  },
  // 4. JavaScript - fetch
  {
    id: "javascript-fetch",
    label: "JavaScript - fetch",
    category: "JavaScript",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "javascript-fetch";
      const lines: string[] = [];
      lines.push("const headers = new Headers();");
      for (const h of headers) {
        lines.push(
          "headers.append(" +
            escapeString(h.key, lang) +
            ", " +
            escapeString(h.value, lang) +
            ");"
        );
      }
      lines.push("");
      lines.push("fetch(" + escapeString(url, lang) + ", {");
      lines.push("  method: " + escapeString(method, lang) + ",");
      if (headers.length > 0) {
        lines.push("  headers: headers,");
      }
      if (hasBody(req)) {
        lines.push("  body: " + escapeString(req.body, lang));
      }
      lines.push("})");
      lines.push("  .then((response) => response.text())");
      lines.push("  .then((result) => console.log(result))");
      lines.push("  .catch((error) => console.error(error));");
      return lines.join("\n");
    },
  },
  // 5. JavaScript - Axios
  {
    id: "javascript-axios",
    label: "JavaScript - Axios",
    category: "JavaScript",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "javascript-axios";
      const lines: string[] = [];
      lines.push("import axios from " + escapeString("axios", lang) + ";");
      lines.push("");
      lines.push("const config = {");
      lines.push("  method: " + escapeString(method, lang) + ",");
      lines.push("  url: " + escapeString(url, lang) + ",");
      if (headers.length > 0) {
        lines.push("  headers: {");
        for (const h of headers) {
          lines.push(
            "    " +
              escapeString(h.key, lang) +
              ": " +
              escapeString(h.value, lang) +
              ","
          );
        }
        lines.push("  },");
      }
      if (hasBody(req)) {
        lines.push("  data: " + escapeString(req.body, lang));
      }
      lines.push("};");
      lines.push("");
      lines.push("axios(config)");
      lines.push("  .then((response) => console.log(JSON.stringify(response.data)))");
      lines.push("  .catch((error) => console.error(error));");
      return lines.join("\n");
    },
  },
  // 6. Node.js - http
  {
    id: "node-http",
    label: "Node.js - http",
    category: "Node.js",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "node-http";
      const isHttps = url.startsWith("https://");
      const mod = isHttps ? "https" : "http";
      const lines: string[] = [];
      lines.push("const " + mod + " = require(" + escapeString(mod, lang) + ");");
      lines.push("");
      lines.push("const url = " + escapeString(url, lang) + ";");
      lines.push("const parsedUrl = new URL(url);");
      lines.push("");
      lines.push("const options = {");
      lines.push("  method: " + escapeString(method, lang) + ",");
      lines.push("  hostname: parsedUrl.hostname,");
      lines.push("  port: parsedUrl.port,");
      lines.push("  path: parsedUrl.pathname + parsedUrl.search,");
      if (headers.length > 0) {
        lines.push("  headers: {");
        for (const h of headers) {
          lines.push(
            "    " + escapeString(h.key, lang) + ": " + escapeString(h.value, lang) + ","
          );
        }
        lines.push("  },");
      }
      lines.push("};");
      lines.push("");
      lines.push("const request = " + mod + ".request(options, (res) => {");
      lines.push("  let data = " + escapeString("", lang) + ";");
      lines.push("  res.on(" + escapeString("data", lang) + ", (chunk) => {");
      lines.push("    data += chunk;");
      lines.push("  });");
      lines.push("  res.on(" + escapeString("end", lang) + ", () => {");
      lines.push("    console.log(data);");
      lines.push("  });");
      lines.push("});");
      lines.push("");
      lines.push("request.on(" + escapeString("error", lang) + ", (error) => {");
      lines.push("  console.error(error);");
      lines.push("});");
      lines.push("");
      if (hasBody(req)) {
        lines.push("request.write(" + escapeString(req.body, lang) + ");");
      }
      lines.push("request.end();");
      return lines.join("\n");
    },
  },
  // 7. Python - requests
  {
    id: "python-requests",
    label: "Python - requests",
    category: "Python",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "python-requests";
      const lines: string[] = [];
      lines.push("import requests");
      lines.push("");
      lines.push("url = " + escapeString(url, lang));
      lines.push("headers = {");
      for (const h of headers) {
        lines.push(
          "    " + escapeString(h.key, lang) + ": " + escapeString(h.value, lang) + ","
        );
      }
      lines.push("}");
      lines.push("");
      if (hasBody(req)) {
        lines.push(
          "response = requests.request(method=" +
            escapeString(method, lang) +
            ", url=url, headers=headers, data=" +
            escapeString(req.body, lang) +
            ")"
        );
      } else {
        lines.push(
          "response = requests.request(method=" +
            escapeString(method, lang) +
            ", url=url, headers=headers)"
        );
      }
      lines.push("");
      lines.push("print(response.text)");
      return lines.join("\n");
    },
  },
  // 8. Python - httpx
  {
    id: "python-httpx",
    label: "Python - httpx",
    category: "Python",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "python-httpx";
      const lines: string[] = [];
      lines.push("import httpx");
      lines.push("");
      lines.push("url = " + escapeString(url, lang));
      lines.push("headers = {");
      for (const h of headers) {
        lines.push(
          "    " + escapeString(h.key, lang) + ": " + escapeString(h.value, lang) + ","
        );
      }
      lines.push("}");
      lines.push("");
      lines.push("with httpx.Client() as client:");
      if (hasBody(req)) {
        lines.push(
          "    response = client.request(method=" +
            escapeString(method, lang) +
            ", url=url, headers=headers, content=" +
            escapeString(req.body, lang) +
            ")"
        );
      } else {
        lines.push(
          "    response = client.request(method=" +
            escapeString(method, lang) +
            ", url=url, headers=headers)"
        );
      }
      lines.push("    print(response.text)");
      return lines.join("\n");
    },
  },
  // 9. Go - net/http
  {
    id: "go-nethttp",
    label: "Go - net/http",
    category: "Go",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "go";
      const lines: string[] = [];
      lines.push("package main");
      lines.push("");
      if (hasBody(req)) {
        lines.push("import (");
        lines.push('\t"fmt"');
        lines.push('\t"io"');
        lines.push('\t"net/http"');
        lines.push('\t"strings"');
        lines.push(")");
      } else {
        lines.push("import (");
        lines.push('\t"fmt"');
        lines.push('\t"io"');
        lines.push('\t"net/http"');
        lines.push(")");
      }
      lines.push("");
      lines.push("func main() {");
      lines.push("\turl := " + escapeString(url, lang));
      lines.push("\tmethod := " + escapeString(method, lang));
      if (hasBody(req)) {
        lines.push("\tpayload := strings.NewReader(" + escapeString(req.body, lang) + ")");
        lines.push("");
        lines.push("\treq, err := http.NewRequest(method, url, payload)");
      } else {
        lines.push("");
        lines.push("\treq, err := http.NewRequest(method, url, nil)");
      }
      lines.push("\tif err != nil {");
      lines.push("\t\tpanic(err)");
      lines.push("\t}");
      for (const h of headers) {
        lines.push(
          "\treq.Header.Add(" +
            escapeString(h.key, lang) +
            ", " +
            escapeString(h.value, lang) +
            ")"
        );
      }
      lines.push("");
      lines.push("\tclient := &http.Client{}");
      lines.push("\tresp, err := client.Do(req)");
      lines.push("\tif err != nil {");
      lines.push("\t\tpanic(err)");
      lines.push("\t}");
      lines.push("\tdefer resp.Body.Close()");
      lines.push("");
      lines.push("\tbody, err := io.ReadAll(resp.Body)");
      lines.push("\tif err != nil {");
      lines.push("\t\tpanic(err)");
      lines.push("\t}");
      lines.push("\tfmt.Println(string(body))");
      lines.push("}");
      return lines.join("\n");
    },
  },
  // 10. Java - OkHttp
  {
    id: "java-okhttp",
    label: "Java - OkHttp",
    category: "Java",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "java-okhttp";
      const withBody = hasBody(req);
      const lines: string[] = [];
      lines.push("import okhttp3.MediaType;");
      lines.push("import okhttp3.OkHttpClient;");
      lines.push("import okhttp3.Request;");
      lines.push("import okhttp3.RequestBody;");
      lines.push("import okhttp3.Response;");
      lines.push("import java.io.IOException;");
      lines.push("");
      lines.push("public class Main {");
      lines.push("    public static void main(String[] args) {");
      lines.push("        OkHttpClient client = new OkHttpClient().newBuilder().build();");
      if (withBody) {
        const ct = resolveContentType(headers, req);
        lines.push("        MediaType mediaType = MediaType.parse(" + escapeString(ct, lang) + ");");
        lines.push(
          "        RequestBody body = RequestBody.create(mediaType, " +
            escapeString(req.body, lang) +
            ");"
        );
      }
      lines.push("        Request request = new Request.Builder()");
      lines.push("            .url(" + escapeString(url, lang) + ")");
      if (withBody) {
        lines.push("            .method(" + escapeString(method, lang) + ", body)");
      } else {
        lines.push("            .method(" + escapeString(method, lang) + ", null)");
      }
      for (const h of headers) {
        lines.push(
          "            .addHeader(" +
            escapeString(h.key, lang) +
            ", " +
            escapeString(h.value, lang) +
            ")"
        );
      }
      lines.push("            .build();");
      lines.push("");
      lines.push("        try {");
      lines.push("            Response response = client.newCall(request).execute();");
      lines.push("            System.out.println(response.body().string());");
      lines.push("        } catch (IOException e) {");
      lines.push("            e.printStackTrace();");
      lines.push("        }");
      lines.push("    }");
      lines.push("}");
      return lines.join("\n");
    },
  },
  // 11. Java - HttpClient (Java 11+)
  {
    id: "java-httpclient",
    label: "Java - HttpClient",
    category: "Java",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "java-httpclient";
      const withBody = hasBody(req);
      const lines: string[] = [];
      lines.push("import java.net.URI;");
      lines.push("import java.net.http.HttpClient;");
      lines.push("import java.net.http.HttpRequest;");
      lines.push("import java.net.http.HttpResponse;");
      lines.push("import java.io.IOException;");
      lines.push("");
      lines.push("public class Main {");
      lines.push(
        "    public static void main(String[] args) throws IOException, InterruptedException {"
      );
      lines.push("        HttpClient client = HttpClient.newHttpClient();");
      lines.push("        HttpRequest request = HttpRequest.newBuilder()");
      lines.push("            .uri(URI.create(" + escapeString(url, lang) + "))");
      for (const h of headers) {
        lines.push(
          "            .header(" +
            escapeString(h.key, lang) +
            ", " +
            escapeString(h.value, lang) +
            ")"
        );
      }
      if (withBody) {
        lines.push(
          "            .method(" +
            escapeString(method, lang) +
            ", HttpRequest.BodyPublishers.ofString(" +
            escapeString(req.body, lang) +
            "))"
        );
      } else if (method === "GET") {
        lines.push("            .GET()");
      } else if (method === "DELETE") {
        lines.push("            .DELETE()");
      } else {
        lines.push(
          "            .method(" +
            escapeString(method, lang) +
            ", HttpRequest.BodyPublishers.noBody())"
        );
      }
      lines.push("            .build();");
      lines.push("");
      lines.push(
        "        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());"
      );
      lines.push("        System.out.println(response.body());");
      lines.push("    }");
      lines.push("}");
      return lines.join("\n");
    },
  },
  // 12. PHP - cURL
  {
    id: "php-curl",
    label: "PHP - cURL",
    category: "PHP",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "php-curl";
      const lines: string[] = [];
      lines.push("<?php");
      lines.push("$curl = curl_init();");
      lines.push("");
      lines.push("curl_setopt_array($curl, array(");
      lines.push("  CURLOPT_URL => " + escapeString(url, lang) + ",");
      lines.push("  CURLOPT_RETURNTRANSFER => true,");
      lines.push("  CURLOPT_FOLLOWLOCATION => true,");
      if (method !== "GET") {
        lines.push("  CURLOPT_CUSTOMREQUEST => " + escapeString(method, lang) + ",");
      }
      if (headers.length > 0) {
        lines.push("  CURLOPT_HTTPHEADER => array(");
        for (const h of headers) {
          lines.push("    " + escapeString(h.key + ": " + h.value, lang) + ",");
        }
        lines.push("  ),");
      }
      if (hasBody(req)) {
        lines.push("  CURLOPT_POSTFIELDS => " + escapeString(req.body, lang) + ",");
      }
      lines.push("));");
      lines.push("");
      lines.push("$response = curl_exec($curl);");
      lines.push("curl_close($curl);");
      lines.push("echo $response;");
      return lines.join("\n");
    },
  },
  // 13. PHP - Guzzle
  {
    id: "php-guzzle",
    label: "PHP - Guzzle",
    category: "PHP",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "php-guzzle";
      const lines: string[] = [];
      lines.push("<?php");
      lines.push("require " + escapeString("vendor/autoload.php", lang) + ";");
      lines.push("");
      lines.push("$client = new GuzzleHttp\\Client();");
      lines.push("");
      if (headers.length > 0) {
        lines.push("$headers = array(");
        for (const h of headers) {
          lines.push(
            "  " + escapeString(h.key, lang) + " => " + escapeString(h.value, lang) + ","
          );
        }
        lines.push(");");
      }
      if (hasBody(req)) {
        lines.push("$body = " + escapeString(req.body, lang) + ";");
      }
      lines.push("");
      lines.push("$options = array(");
      if (headers.length > 0) {
        lines.push("  " + escapeString("headers", lang) + " => $headers,");
      }
      if (hasBody(req)) {
        lines.push("  " + escapeString("body", lang) + " => $body,");
      }
      lines.push(");");
      lines.push("");
      lines.push(
        "$response = $client->request(" +
          escapeString(method, lang) +
          ", " +
          escapeString(url, lang) +
          ", $options);"
      );
      lines.push("echo $response->getBody();");
      return lines.join("\n");
    },
  },
  // 14. Ruby - Net::HTTP
  {
    id: "ruby-nethttp",
    label: "Ruby - Net::HTTP",
    category: "Ruby",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "ruby-nethttp";
      const rubyClassMap: Record<string, string> = {
        GET: "Get",
        POST: "Post",
        PUT: "Put",
        DELETE: "Delete",
        PATCH: "Patch",
        HEAD: "Head",
        OPTIONS: "Options",
      };
      const className = rubyClassMap[method] || "Get";
      const lines: string[] = [];
      lines.push("require " + escapeString("net/http", lang));
      lines.push("require " + escapeString("uri", lang));
      lines.push("");
      lines.push("uri = URI.parse(" + escapeString(url, lang) + ")");
      lines.push("http = Net::HTTP.new(uri.host, uri.port)");
      lines.push("http.use_ssl = uri.scheme == " + escapeString("https", lang));
      lines.push("");
      lines.push("request = Net::HTTP::" + className + ".new(uri.request_uri)");
      for (const h of headers) {
        lines.push(
          "request[" + escapeString(h.key, lang) + "] = " + escapeString(h.value, lang)
        );
      }
      if (hasBody(req)) {
        lines.push("request.body = " + escapeString(req.body, lang));
      }
      lines.push("");
      lines.push("response = http.request(request)");
      lines.push("puts response.body");
      return lines.join("\n");
    },
  },
  // 15. Rust - reqwest
  {
    id: "rust-reqwest",
    label: "Rust - reqwest",
    category: "Rust",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "rust-reqwest";
      const lines: string[] = [];
      lines.push("extern crate reqwest;");
      lines.push("");
      lines.push("fn main() -> Result<(), Box<dyn std::error::Error>> {");
      lines.push("    let client = reqwest::blocking::Client::builder()");
      lines.push("        .build()?;");
      lines.push("");
      lines.push("    let method = reqwest::Method::from_bytes(b\"" + method + "\").unwrap();");
      lines.push("");
      lines.push("    let res = client");
      lines.push("        .request(method, " + escapeString(url, lang) + ")");
      for (const h of headers) {
        lines.push(
          "        .header(" +
            escapeString(h.key, lang) +
            ", " +
            escapeString(h.value, lang) +
            ")"
        );
      }
      if (hasBody(req)) {
        lines.push("        .body(" + escapeString(req.body, lang) + ")");
      }
      lines.push("        .send()?");
      lines.push("        .text()?;");
      lines.push("");
      lines.push("    println!(\"{}\", res);");
      lines.push("    Ok(())");
      lines.push("}");
      return lines.join("\n");
    },
  },
  // 16. C# - HttpClient
  {
    id: "csharp-httpclient",
    label: "C# - HttpClient",
    category: "C#",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "csharp-httpclient";
      const withBody = hasBody(req);
      const lines: string[] = [];
      lines.push("using System.Net.Http;");
      lines.push("using System.Threading.Tasks;");
      lines.push("");
      lines.push("var client = new HttpClient();");
      lines.push(
        "var request = new HttpRequestMessage(new HttpMethod(" +
          escapeString(method, lang) +
          "), " +
          escapeString(url, lang) +
          ");"
      );
      for (const h of headers) {
        lines.push(
          "request.Headers.Add(" +
            escapeString(h.key, lang) +
            ", " +
            escapeString(h.value, lang) +
            ");"
        );
      }
      if (withBody) {
        const ct = resolveContentType(headers, req);
        lines.push(
          "var content = new StringContent(" +
            escapeString(req.body, lang) +
            ", null, " +
            escapeString(ct, lang) +
            ");"
        );
        lines.push("request.Content = content;");
      }
      lines.push("");
      lines.push("var response = await client.SendAsync(request);");
      lines.push("var responseBody = await response.Content.ReadAsStringAsync();");
      lines.push("System.Console.WriteLine(responseBody);");
      return lines.join("\n");
    },
  },
  // 17. Swift - URLSession
  {
    id: "swift-urlsession",
    label: "Swift - URLSession",
    category: "Swift",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "swift-urlsession";
      const lines: string[] = [];
      lines.push("let url = URL(string: " + escapeString(url, lang) + ")!");
      lines.push("var request = URLRequest(url: url)");
      lines.push("request.httpMethod = " + escapeString(method, lang));
      for (const h of headers) {
        lines.push(
          "request.addValue(" +
            escapeString(h.value, lang) +
            ", forHTTPHeaderField: " +
            escapeString(h.key, lang) +
            ")"
        );
      }
      if (hasBody(req)) {
        lines.push(
          "request.httpBody = " +
            escapeString(req.body, lang) +
            ".data(using: .utf8)"
        );
      }
      lines.push("");
      lines.push("let task = URLSession.shared.dataTask(with: request) { data, response, error in");
      lines.push("    if let error = error {");
      lines.push("        print(error)");
      lines.push("        return");
      lines.push("    }");
      lines.push("    if let data = data, let string = String(data: data, encoding: .utf8) {");
      lines.push("        print(string)");
      lines.push("    }");
      lines.push("}");
      lines.push("task.resume()");
      return lines.join("\n");
    },
  },
  // 18. Kotlin - OkHttp
  {
    id: "kotlin-okhttp",
    label: "Kotlin - OkHttp",
    category: "Kotlin",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "kotlin-okhttp";
      const withBody = hasBody(req);
      const lines: string[] = [];
      lines.push("import okhttp3.MediaType.Companion.toMediaTypeOrNull");
      lines.push("import okhttp3.OkHttpClient");
      lines.push("import okhttp3.Request");
      lines.push("import okhttp3.RequestBody.Companion.toRequestBody");
      lines.push("");
      lines.push("val client = OkHttpClient()");
      if (withBody) {
        const ct = resolveContentType(headers, req);
        lines.push("val mediaType = " + escapeString(ct, lang) + ".toMediaTypeOrNull()");
        lines.push(
          "val body = " + escapeString(req.body, lang) + ".toRequestBody(mediaType)"
        );
      }
      lines.push("val request = Request.Builder()");
      lines.push("    .url(" + escapeString(url, lang) + ")");
      if (withBody) {
        lines.push("    .method(" + escapeString(method, lang) + ", body)");
      } else {
        lines.push("    .method(" + escapeString(method, lang) + ", null)");
      }
      for (const h of headers) {
        lines.push(
          "    .addHeader(" +
            escapeString(h.key, lang) +
            ", " +
            escapeString(h.value, lang) +
            ")"
        );
      }
      lines.push("    .build()");
      lines.push("");
      lines.push("client.newCall(request).execute().use { response ->");
      lines.push("    println(response.body?.string())");
      lines.push("}");
      return lines.join("\n");
    },
  },
  // 19. Dart - http
  {
    id: "dart-http",
    label: "Dart - http",
    category: "Dart",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toUpperCase();
      const lang = "dart-http";
      const lines: string[] = [];
      lines.push("import " + escapeString("package:http/http.dart", lang) + " as http;");
      lines.push("");
      lines.push("void main() async {");
      if (headers.length > 0) {
        lines.push("  var headers = {");
        for (const h of headers) {
          lines.push(
            "    " + escapeString(h.key, lang) + ": " + escapeString(h.value, lang) + ","
          );
        }
        lines.push("  };");
      }
      lines.push("  var request = http.Request(" + escapeString(method, lang) + ", Uri.parse(" + escapeString(url, lang) + "));");
      if (headers.length > 0) {
        lines.push("  request.headers.addAll(headers);");
      }
      if (hasBody(req)) {
        lines.push("  request.body = " + escapeString(req.body, lang) + ";");
      }
      lines.push("");
      lines.push("  var client = http.Client();");
      lines.push("  var streamedResponse = await client.send(request);");
      lines.push("  var response = await http.Response.fromStream(streamedResponse);");
      lines.push("  print(response.body);");
      lines.push("  client.close();");
      lines.push("}");
      return lines.join("\n");
    },
  },
  // 20. Clojure - clj-http
  {
    id: "clojure-cljhttp",
    label: "Clojure - clj-http",
    category: "Clojure",
    generate: (req) => {
      const url = buildUrl(req);
      const headers = buildHeaders(req);
      const method = req.method.toLowerCase();
      const lang = "clojure-cljhttp";
      const lines: string[] = [];
      lines.push("(require '[clj-http.client :as client])");
      lines.push("");
      lines.push("(let [response (client/request {:method :" + method);
      lines.push("                        :url " + escapeString(url, lang));
      if (headers.length > 0) {
        lines.push("                        :headers {");
        for (const h of headers) {
          lines.push(
            "                          " +
              escapeString(h.key, lang) +
              " " +
              escapeString(h.value, lang)
          );
        }
        lines.push("                        }");
      }
      if (hasBody(req)) {
        lines.push("                        :body " + escapeString(req.body, lang));
      }
      lines.push("                        })]");
      lines.push("  (println (:body response)))");
      return lines.join("\n");
    },
  },
];

// Generate code for a language id. Unknown ids return an empty string.
export function generateCode(langId: string, req: CodegenRequest): string {
  const lang = CODEGEN_LANGUAGES.find((l) => l.id === langId);
  if (!lang) {
    return "";
  }
  const code = lang.generate(req);
  if (!code) {
    return "";
  }
  return req.bodyType === "binary" ? code + "\n" + binaryNotice(lang.id) : code;
}
