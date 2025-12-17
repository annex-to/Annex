/**
 * Version Command
 *
 * Displays version information.
 */

import { VERSION, BUILD_DATE, BUILD_TIMESTAMP } from "../version.js";
import * as os from "os";

export function version(): void {
  console.log(`
Annex Encoder ${VERSION}

Build Date:   ${BUILD_DATE}
Build Time:   ${new Date(BUILD_TIMESTAMP).toLocaleString()}
Platform:     ${os.platform()}-${os.arch()}
Node Version: ${process.version}
`);
}
