import { SyntaxStyle } from "@opentui/core"
import { THEME } from "../utils/uiTheme.js"

let sharedStyle: SyntaxStyle | null = null

export function getMarkdownSyntaxStyle(): SyntaxStyle {
  if (!sharedStyle) {
    sharedStyle = SyntaxStyle.fromStyles({
      default: { fg: THEME.fgPrimary },
      conceal: { fg: THEME.fgMuted },
      "markup.heading": { fg: THEME.accentCyan, bold: true },
      "markup.strong": { fg: "#ffffff", bold: true },
      "markup.italic": { fg: THEME.accentPurple, italic: true },
      "markup.raw": { fg: THEME.accentAmber, bg: THEME.bgPill },
      "markup.link": { fg: THEME.accentBlue, underline: true },
      "markup.list": { fg: THEME.accentCyan, bold: true },
      "markup.quote": { fg: THEME.fgSecondary, italic: true },
    })
  }
  return sharedStyle
}
