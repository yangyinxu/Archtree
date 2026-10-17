# Engineering guide

The independent **Engineering Guide** at `/engineering` introduces the system,
local setup, module responsibilities, a complete Album request walkthrough, and
the checks needed for a change. Its sidebar, source links, and page outlines work
independently of the Finitude listener. Administrators see an entry on the Archtree
landing page. Pages and assets require the existing administrator session; a
signed-out visitor returns to the requested guide page after Archtree login, and
an ordinary account receives `403`. The guide does not grant or change any role.

English pages use `/engineering` and `/engineering/<topic>`; Simplified Chinese
pages use `/engineering/zh-hans` and `/engineering/zh-hans/<topic>`. The header's
English / 简体中文 switch preserves the current topic. Language selection is
encoded in the URL and does not change the Finitude language preference.

To read or review the guide locally without application credentials or a database:

```sh
npm ci
npm run preview:engineering
```

Open `http://127.0.0.1:4174/engineering`. This command builds the guide and starts
a documentation-only, read-only preview bound to loopback. Stop it with Ctrl+C;
rebuild and restart after changing content. The application route uses the same
generated pages with server-side authorization.

English explanations live in `docs/engineering/guide.json`, and English interface
copy lives in `engineering/locales/en-US.json`. The complete Chinese translation
is maintained in `docs/engineering/locales/zh-Hans.json`; see the
[Engineering Guide localization workflow](../features/localization.md#engineering-guide-localization)
when editing either language. The existing business rules, architecture,
development-environment documentation, and code remain the authoritative sources.
`npm run build:engineering` validates the page schema,
internal page/section links, referenced repository files and text anchors, and
documented npm commands, plus translation keys, interface placeholders, and the
English source digest. It emits 26 static topic pages across both languages,
with escaped HTML and local CSS/JavaScript, to the ignored `engineering/dist`
directory. No runtime route reads arbitrary
repository documents, and no third-party service is needed to render the guide.
The build is included in `npm run build`; restart the server after rebuilding.

Each page identifies its source commit. A dirty checkout is visibly marked as a
working copy, whose source links open the base commit and may differ from local
changes. Release staging includes only `engineering/dist`, rejects missing or
invalid guide bundles, and requires a clean guide built from the release commit.
The guide marks future work separately from implemented behavior; dated test
evidence in source documents must never be presented as current verification.
