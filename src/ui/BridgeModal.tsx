import React from "react"
import {
  CLAUDE_TIER_MODEL_PRESETS,
  CODEX_EFFORT_PRESETS,
  deriveBridgePrefix,
  type BridgeAgentMappingItem,
  type BridgeField,
  type BridgePackOption,
} from "../utils/bridgePrompt.js"
import type { TranslationTarget, TranslationTier } from "../utils/translationConfig.js"
import { displayWidth, middleEllipsis, terminalSafeText } from "../utils/terminalText.js"
import { THEME } from "../utils/uiTheme.js"

export interface BridgeModalLayout {
  wide: boolean
  modalWidth: number
  modalHeight: number
  left: number
  top: number
  innerWidth: number
  packViewportRows: number
  tierViewportRows: number
  agentViewportRows: number
}

export function calculateBridgeModalLayout(
  termWidth: number,
  termHeight: number,
  options: { packExpanded: boolean; tierCount: number },
): BridgeModalLayout {
  const w = Math.max(40, Math.floor(termWidth))
  const h = Math.max(18, Math.floor(termHeight))
  const wide = w >= 96 && h >= 26

  if (wide) {
    const modalWidth = Math.min(w - 4, 112)
    const modalHeight = Math.min(h - 2, 32)
    const left = Math.max(0, Math.floor((w - modalWidth) / 2))
    const top = Math.max(0, Math.floor((h - modalHeight) / 2))
    const innerWidth = Math.max(40, modalWidth - 4)
    const bodyHeight = Math.max(12, modalHeight - 7) // border(2) + padding(2) + title(1) + footer(2)
    const packViewportRows = Math.max(2, Math.min(4, bodyHeight - 16))
    const tierViewportRows = Math.max(2, Math.min(Math.max(1, options.tierCount), bodyHeight - 13))
    const agentViewportRows = Math.max(3, bodyHeight - 5)
    return {
      wide,
      modalWidth,
      modalHeight,
      left,
      top,
      innerWidth,
      packViewportRows,
      tierViewportRows,
      agentViewportRows,
    }
  }

  const modalWidth = Math.max(40, w - 4)
  const modalHeight = Math.max(18, h - 2)
  const left = Math.max(0, Math.floor((w - modalWidth) / 2))
  const top = Math.max(0, Math.floor((h - modalHeight) / 2))
  const innerWidth = Math.max(32, modalWidth - 4)
  const innerHeight = Math.max(14, modalHeight - 2) // vertical padding is 0 in compact mode
  const packViewportRows = 2
  const tierViewportRows = Math.max(1, Math.min(3, Math.max(1, options.tierCount)))
  const packRowsUsed = options.packExpanded ? 1 + packViewportRows : 1
  const fixedRows = 1 + 1 + packRowsUsed + (1 + tierViewportRows) + 1 + 1 + 1 + 2
  const agentViewportRows = Math.max(2, innerHeight - fixedRows)

  return {
    wide,
    modalWidth,
    modalHeight,
    left,
    top,
    innerWidth,
    packViewportRows,
    tierViewportRows,
    agentViewportRows,
  }
}

function tierColor(tier: string): string {
  if (tier === "planning") return THEME.accentPurple
  if (tier === "execution") return THEME.accentCyan
  if (tier === "light") return THEME.accentGreen
  return THEME.accentAmber
}

function shortSourceLabel(source: BridgeAgentMappingItem["source"]): string {
  if (source === "model-map") return "map"
  if (source === "inferred") return "inf"
  if (source === "default") return "def"
  if (source === "override") return "ovr"
  return "role"
}

export interface BridgeModalProps {
  target: TranslationTarget
  focusedField: BridgeField
  pluginName: string
  selectedPack: string
  suggestedPack: string
  packQuery: string
  allPacks: ReadonlyArray<BridgePackOption>
  filteredPacks: ReadonlyArray<BridgePackOption>
  packIndex: number
  packScrollOffset: number
  tiers: Readonly<Record<string, TranslationTier>>
  tierIndex: number
  tierScrollOffset: number
  previewItems: ReadonlyArray<BridgeAgentMappingItem>
  tierCounts: Readonly<Record<string, number>>
  agentIndex: number
  agentScrollOffset: number
  modelTarget: string
  tiersDirty: boolean
  termWidth: number
  termHeight: number
  onFocusField: (field: BridgeField) => void
  onChangePluginName: (value: string) => void
  onChangePackQuery: (value: string) => void
  onSelectPackAt: (filteredIndex: number, pack: string) => void
  onSelectTierIndex: (index: number) => void
  onChangeTierModel: (tierName: string, model: string) => void
  onSelectTierEffort: (tierName: string, effort: string) => void
  onSelectAgentIndex: (index: number) => void
  onCycleAgentTierAt: (index: number, delta: 1 | -1) => void
  onChangeModelTarget: (value: string) => void
  onSaveTiers: () => void
  onSubmit: () => void
  onClose: () => void
}

export function BridgeModal({
  target,
  focusedField,
  pluginName,
  selectedPack,
  suggestedPack,
  packQuery,
  allPacks,
  filteredPacks,
  packIndex,
  packScrollOffset,
  tiers,
  tierIndex,
  tierScrollOffset,
  previewItems,
  tierCounts,
  agentIndex,
  agentScrollOffset,
  modelTarget,
  tiersDirty,
  termWidth,
  termHeight,
  onFocusField,
  onChangePluginName,
  onChangePackQuery,
  onSelectPackAt,
  onSelectTierIndex,
  onChangeTierModel,
  onSelectTierEffort,
  onSelectAgentIndex,
  onCycleAgentTierAt,
  onChangeModelTarget,
  onSaveTiers,
  onSubmit,
  onClose,
}: BridgeModalProps) {
  const tierNames = Object.keys(tiers)
  const layout = calculateBridgeModalLayout(termWidth, termHeight, {
    packExpanded: focusedField === "pack",
    tierCount: tierNames.length,
  })
  const accent = target === "codex" ? THEME.accentBlue : "#FF6B35"
  const selectedPackInfo = allPacks.find(item => item.pack === selectedPack)
  const previewPluginSlug = terminalSafeText(pluginName.trim()) || "..."
  const previewPackLabel = terminalSafeText(selectedPack) || "..."
  const strippedPrefix = deriveBridgePrefix(selectedPack) || "..."

  const visiblePacks = filteredPacks.slice(packScrollOffset, packScrollOffset + layout.packViewportRows)
  const visibleTierNames = tierNames.slice(tierScrollOffset, tierScrollOffset + layout.tierViewportRows)
  const visibleAgents = previewItems.slice(agentScrollOffset, agentScrollOffset + layout.agentViewportRows)

  const tierSummaryBadges = tierNames
    .map(t => `${tierCounts[t] ?? 0} ${terminalSafeText(t)}`)
    .join(" · ")

  const isTiersActive = focusedField === "tiers" || focusedField === "effort"

  const renderTierRows = (maxRowWidth: number) =>
    visibleTierNames.map((tierName, idx) => {
      const globalIdx = tierScrollOffset + idx
      const tierCfg = tiers[tierName]
      const isRowSelected = globalIdx === tierIndex
      const safeTierLabel = terminalSafeText(tierName)
      const currentModel = terminalSafeText(target === "codex" ? tierCfg.codex.model : tierCfg.claude.model)
      const currentEffort = terminalSafeText(tierCfg.codex.reasoningEffort || "high")

      if (target === "claude") {
        const isCustomClaude = Boolean(currentModel) && !(CLAUDE_TIER_MODEL_PRESETS as readonly string[]).includes(currentModel)
        return (
          <box
            key={`tier-${tierName}`}
            width="100%"
            height={1}
            flexDirection="row"
            justifyContent="space-between"
            backgroundColor={isTiersActive && isRowSelected ? THEME.bgRowFocus : "transparent"}
            flexShrink={0}
            onMouseDown={(_self, event) => {
              event.stopPropagation()
              onFocusField("tiers")
              onSelectTierIndex(globalIdx)
            }}
          >
            <text height={1} wrapMode="none" flexShrink={0} style={{ textColor: tierColor(tierName) }} b={isRowSelected}>
              {`${isTiersActive && isRowSelected ? "▎ " : "  "}${middleEllipsis(safeTierLabel, 10).padEnd(10, " ")}`}
            </text>
            <box flexDirection="row" gap={1} height={1} overflow="hidden" flexShrink={1}>
              {CLAUDE_TIER_MODEL_PRESETS.map(preset => {
                const active = currentModel === preset
                return (
                  <text
                    key={`${tierName}-${preset}`}
                    height={1}
                    wrapMode="none"
                    backgroundColor={active ? (isTiersActive && isRowSelected ? accent : THEME.bgPillActive) : THEME.bgPill}
                    style={{ textColor: active ? (isTiersActive && isRowSelected ? THEME.bgBase : "#ffffff") : THEME.fgSecondary }}
                    b={active}
                    onMouseDown={(_self, event) => {
                      event.stopPropagation()
                      onFocusField("tiers")
                      onSelectTierIndex(globalIdx)
                      onChangeTierModel(tierName, preset)
                    }}
                  >
                    {` ${active ? "● " : ""}${preset} `}
                  </text>
                )
              })}
              {isCustomClaude && (
                <text height={1} wrapMode="none" backgroundColor={THEME.bgPillActive} style={{ textColor: "#ffffff" }} b>
                  {` ● ${middleEllipsis(terminalSafeText(currentModel), Math.max(8, maxRowWidth - 36))} `}
                </text>
              )}
            </box>
          </box>
        )
      }

      // Codex target: editable model ID + reasoningEffort selector
      const editingModelHere = focusedField === "tiers" && isRowSelected
      const editingEffortHere = focusedField === "effort" && isRowSelected
      const modelWidth = Math.max(12, maxRowWidth - 24)
      return (
        <box
          key={`tier-${tierName}`}
          width="100%"
          height={1}
          flexDirection="row"
          justifyContent="space-between"
          backgroundColor={isTiersActive && isRowSelected ? THEME.bgRowFocus : "transparent"}
          flexShrink={0}
          onMouseDown={(_self, event) => {
            event.stopPropagation()
            onFocusField("tiers")
            onSelectTierIndex(globalIdx)
          }}
        >
          <text width={12} height={1} wrapMode="none" flexShrink={0} style={{ textColor: tierColor(tierName) }} b={isRowSelected}>
            {`${isTiersActive && isRowSelected ? "▎ " : "  "}${middleEllipsis(safeTierLabel, 10)}`}
          </text>
          {editingModelHere ? (
            <input
              width={modelWidth}
              value={currentModel}
              placeholder="codex model id"
              placeholderColor={THEME.fgMuted}
              focused={true}
              onInput={val => onChangeTierModel(tierName, val)}
              onSubmit={onSubmit}
            />
          ) : (
            <text width={modelWidth} height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgPrimary }}>
              {middleEllipsis(terminalSafeText(currentModel) || "(empty)", modelWidth - 1)}
            </text>
          )}
          <text
            height={1}
            wrapMode="none"
            flexShrink={0}
            backgroundColor={editingEffortHere ? accent : THEME.bgPill}
            style={{ textColor: editingEffortHere ? THEME.bgBase : THEME.accentCyan }}
            b={editingEffortHere}
            onMouseDown={(_self, event) => {
              event.stopPropagation()
              onFocusField("effort")
              onSelectTierIndex(globalIdx)
              const nextIdx = (CODEX_EFFORT_PRESETS.indexOf(currentEffort as any) + 1) % CODEX_EFFORT_PRESETS.length
              onSelectTierEffort(tierName, CODEX_EFFORT_PRESETS[nextIdx])
            }}
          >
            {` ${currentEffort} `}
          </text>
        </box>
      )
    })

  const renderAgentRows = (rowWidth: number) => {
    if (previewItems.length === 0) {
      return (
        <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
          {"  No agents in selected pack."}
        </text>
      )
    }
    return visibleAgents.map((item, idx) => {
      const globalIdx = agentScrollOffset + idx
      const isFocusedRow = focusedField === "agents" && globalIdx === agentIndex
      const modelLabel = item.reasoningEffort ? `${item.targetModel}:${item.reasoningEffort}` : item.targetModel
      const srcTag = shortSourceLabel(item.source)
      const rightSummary = `[${item.tier}] → ${middleEllipsis(terminalSafeText(modelLabel), Math.max(6, Math.floor(rowWidth * 0.34)))} ${srcTag}`
      const nameBudget = Math.max(8, rowWidth - displayWidth(rightSummary) - 4)
      const srcColor = item.source === "override" || item.source === "model-map"
        ? THEME.accentAmber
        : item.source === "role"
          ? THEME.fgSecondary
          : THEME.fgMuted

      return (
        <box
          key={item.currentPath}
          width="100%"
          height={1}
          flexDirection="row"
          justifyContent="space-between"
          backgroundColor={isFocusedRow ? THEME.bgRowFocus : "transparent"}
          flexShrink={0}
          onMouseDown={(_self, event) => {
            event.stopPropagation()
            if (focusedField === "agents" && globalIdx === agentIndex) {
              onCycleAgentTierAt(globalIdx, 1)
            } else {
              onFocusField("agents")
              onSelectAgentIndex(globalIdx)
            }
          }}
        >
          <text
            height={1}
            wrapMode="none"
            overflow="hidden"
            style={{ textColor: isFocusedRow ? "#ffffff" : THEME.fgPrimary }}
            b={isFocusedRow}
          >
            {`${isFocusedRow ? "▎ " : "  "}${middleEllipsis(terminalSafeText(item.strippedName), nameBudget)}`}
          </text>
          <box flexDirection="row" height={1} flexShrink={0}>
            <text
              height={1}
              wrapMode="none"
              style={{ textColor: tierColor(item.tier) }}
              b
              onMouseDown={(_self, event) => {
                event.stopPropagation()
                onFocusField("agents")
                onSelectAgentIndex(globalIdx)
                onCycleAgentTierAt(globalIdx, 1)
              }}
            >
              {`[${terminalSafeText(item.tier)}]`}
            </text>
            <text height={1} wrapMode="none" style={{ textColor: THEME.fgPrimary }}>
              {` → ${middleEllipsis(terminalSafeText(modelLabel), Math.max(6, Math.floor(rowWidth * 0.34)))} `}
            </text>
            <text height={1} wrapMode="none" style={{ textColor: srcColor }}>
              {srcTag}
            </text>
          </box>
        </box>
      )
    })
  }

  const renderPackList = () => (
    <box width="100%" flexDirection="column" paddingLeft={2} flexShrink={0} overflow="hidden">
      {filteredPacks.length === 0 ? (
        <text height={1} wrapMode="none" flexShrink={0} style={{ textColor: THEME.accentRed }}>
          (no matching packs)
        </text>
      ) : (
        visiblePacks.map(({ pack, count }, index) => {
          const globalIndex = packScrollOffset + index
          const isCurrentChoice = globalIndex === packIndex
          return (
            <box
              key={pack}
              width="100%"
              height={1}
              flexShrink={0}
              backgroundColor={isCurrentChoice ? THEME.bgRowFocus : "transparent"}
              onMouseDown={(_self, event) => {
                event.stopPropagation()
                onSelectPackAt(globalIndex, pack)
              }}
            >
              <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: isCurrentChoice ? THEME.accentAmber : THEME.fgSecondary }} b={isCurrentChoice}>
                {`${isCurrentChoice ? "▎ " : "  "}${middleEllipsis(terminalSafeText(pack), 26)}  (${count} agents)${pack === suggestedPack ? " · current" : ""}`}
              </text>
            </box>
          )
        })
      )}
    </box>
  )

  const leftColWidth = layout.wide ? Math.floor((layout.innerWidth - 1) * 0.48) : layout.innerWidth
  const rightColWidth = layout.wide ? layout.innerWidth - 1 - leftColWidth : layout.innerWidth

  return (
    <box
      position="absolute"
      left={layout.left}
      top={layout.top}
      width={layout.modalWidth}
      height={layout.modalHeight}
      zIndex={45}
      border={true}
      borderStyle="rounded"
      borderColor={accent}
      backgroundColor={THEME.bgElevated}
      title={` Bridge to ${target === "codex" ? "Codex" : "Claude Code"}${tiersDirty ? " *" : ""} `}
      titleColor={accent}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={layout.wide ? 1 : 0}
      paddingBottom={layout.wide ? 1 : 0}
      flexDirection="column"
      justifyContent="space-between"
      overflow="hidden"
    >
      <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
        {/* Header */}
        <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
          <box flexDirection="row" height={1} overflow="hidden">
            <text height={1} wrapMode="none" style={{ textColor: THEME.fgPrimary }} b>
              {`BRIDGE TO ${target === "codex" ? "CODEX" : "CLAUDE CODE"} `}
            </text>
            <text height={1} wrapMode="none" style={{ textColor: accent }} b>
              {`OpenCode → ${target === "codex" ? "Codex Translation Layer" : "Claude Code Plugin"}`}
            </text>
          </box>
          {layout.wide && (
            <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
              {`Pack '${previewPackLabel}' · ${previewItems.length} agents`}
            </text>
          )}
        </box>

        {layout.wide ? (
          /* Wide Two-Column Split: Left = Setup & Tiers, Right = Live Pack Mapping */
          <box flexDirection="row" width="100%" flexGrow={1} minHeight={0} marginTop={1} overflow="hidden">
            <box width={leftColWidth} flexDirection="column" justifyContent="space-between" overflow="hidden" flexShrink={0}>
              <box flexDirection="column" overflow="hidden">
                {/* 1. Plugin Name */}
                <box
                  flexDirection="row"
                  border={true}
                  borderStyle="rounded"
                  borderColor={focusedField === "name" ? accent : THEME.borderSubtle}
                  backgroundColor={THEME.bgInput}
                  paddingLeft={1}
                  paddingRight={1}
                  height={3}
                  flexShrink={0}
                  onMouseDown={() => onFocusField("name")}
                >
                  <text width={16} height={1} wrapMode="none" flexShrink={0} style={{ textColor: focusedField === "name" ? accent : THEME.fgSecondary }} b>
                    {focusedField === "name" ? "▎ Plugin Name:" : "  Plugin Name:"}
                  </text>
                  <input
                    width={Math.max(10, leftColWidth - 20)}
                    value={pluginName}
                    placeholder="insert name"
                    placeholderColor={THEME.fgMuted}
                    focused={focusedField === "name"}
                    onInput={onChangePluginName}
                    onSubmit={onSubmit}
                  />
                </box>

                {/* 2. Pack Selector */}
                <box
                  flexDirection="column"
                  border={true}
                  borderStyle="rounded"
                  borderColor={focusedField === "pack" ? accent : THEME.borderSubtle}
                  backgroundColor={THEME.bgInput}
                  paddingLeft={1}
                  paddingRight={1}
                  flexShrink={0}
                  onMouseDown={() => onFocusField("pack")}
                >
                  <box flexDirection="row" width="100%" height={1} flexShrink={0}>
                    <text width={16} height={1} wrapMode="none" flexShrink={0} style={{ textColor: focusedField === "pack" ? accent : THEME.fgSecondary }} b>
                      {focusedField === "pack" ? "▎ Pack:" : "  Pack:"}
                    </text>
                    {focusedField === "pack" ? (
                      <input
                        width={Math.max(10, leftColWidth - 20)}
                        value={packQuery}
                        placeholder="type to filter packs..."
                        placeholderColor={THEME.fgMuted}
                        focused={true}
                        onInput={onChangePackQuery}
                        onSubmit={onSubmit}
                      />
                    ) : (
                      <text width={Math.max(10, leftColWidth - 20)} height={1} wrapMode="none" overflow="hidden" style={{ textColor: selectedPack ? THEME.fgPrimary : THEME.accentRed }} b={Boolean(selectedPack)}>
                        {selectedPack
                          ? `${terminalSafeText(selectedPack)}${selectedPackInfo ? `  (${selectedPackInfo.count} agents)` : ""}${selectedPack === suggestedPack ? " · current" : ""}`
                          : "(no pack selected)"}
                      </text>
                    )}
                  </box>
                  {focusedField === "pack" && renderPackList()}
                </box>

                {/* 3. Tiers Editor */}
                <box
                  flexDirection="column"
                  border={true}
                  borderStyle="rounded"
                  borderColor={isTiersActive ? accent : THEME.borderSubtle}
                  backgroundColor={THEME.bgInput}
                  paddingLeft={1}
                  paddingRight={1}
                  flexShrink={0}
                  onMouseDown={() => onFocusField("tiers")}
                >
                  <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
                    <text height={1} wrapMode="none" style={{ textColor: isTiersActive ? accent : THEME.fgSecondary }} b>
                      {isTiersActive
                        ? `▎ Tiers (${target === "codex" ? (focusedField === "effort" ? "Codex · effort" : "Codex · model") : "Claude"}):`
                        : `  Tiers (${target === "codex" ? "Codex" : "Claude"}):`}
                    </text>
                    <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                      {target === "codex"
                        ? (focusedField === "effort" ? "↑/↓ tier · ←/→ effort" : "↑/↓ tier · TAB effort")
                        : "↑/↓ tier · ←/→ model"}
                    </text>
                  </box>
                  {renderTierRows(Math.max(20, leftColWidth - 4))}
                </box>

                {/* 4. Catch-all Model Override */}
                <box
                  flexDirection="row"
                  border={true}
                  borderStyle="rounded"
                  borderColor={focusedField === "model" ? accent : THEME.borderSubtle}
                  backgroundColor={THEME.bgInput}
                  paddingLeft={1}
                  paddingRight={1}
                  height={3}
                  flexShrink={0}
                  onMouseDown={() => onFocusField("model")}
                >
                  <text width={16} height={1} wrapMode="none" flexShrink={0} style={{ textColor: focusedField === "model" ? accent : THEME.fgSecondary }} b>
                    {focusedField === "model" ? "▎ Map all to:" : "  Map all to:"}
                  </text>
                  <input
                    width={Math.max(10, leftColWidth - 20)}
                    value={modelTarget}
                    placeholder="empty = tier mapping"
                    placeholderColor={THEME.fgMuted}
                    focused={focusedField === "model"}
                    onInput={onChangeModelTarget}
                    onSubmit={onSubmit}
                  />
                </box>
              </box>

              <box flexDirection="column" flexShrink={0}>
                <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
                  {middleEllipsis(`Source: pack '${previewPackLabel}' (+requires, strips '${strippedPrefix}')`, leftColWidth)}
                </text>
                <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }}>
                  {middleEllipsis(`Output: bridges/${target === "codex" ? "codex" : "claude-code"}/${previewPluginSlug}/`, leftColWidth)}
                </text>
              </box>
            </box>

            <box width={1} flexShrink={0} />

            {/* Right Column: Live Pack Mapping & Agent Tier Reassignment */}
            <box
              width={rightColWidth}
              flexDirection="column"
              justifyContent="space-between"
              border={true}
              borderStyle="rounded"
              borderColor={focusedField === "agents" ? accent : THEME.borderSubtle}
              backgroundColor={THEME.bgInput}
              paddingLeft={1}
              paddingRight={1}
              overflow="hidden"
              flexShrink={0}
              onMouseDown={() => onFocusField("agents")}
            >
              <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
                <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
                  <text height={1} wrapMode="none" style={{ textColor: focusedField === "agents" ? accent : THEME.fgPrimary }} b>
                    {focusedField === "agents"
                      ? `▎ Pack '${previewPackLabel}' Mapping (${previewItems.length})`
                      : `  Pack '${previewPackLabel}' Mapping (${previewItems.length})`}
                  </text>
                </box>
                <box
                  height={1}
                  borderStyle="single"
                  border={["bottom"]}
                  borderColor={THEME.borderSubtle}
                  flexShrink={0}
                >
                  <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgMuted }}>
                    {middleEllipsis(tierSummaryBadges || "No tiers", Math.max(12, rightColWidth - 4))}
                  </text>
                </box>

                <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
                  {renderAgentRows(Math.max(20, rightColWidth - 4))}
                </box>
              </box>

              <box
                height={1}
                borderStyle="single"
                border={["top"]}
                borderColor={THEME.borderSubtle}
                flexDirection="row"
                justifyContent="space-between"
                flexShrink={0}
              >
                <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                  ↑/↓ agent · ←/→ or Space assign tier
                </text>
                {previewItems.length > 0 && (
                  <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                    {`${Math.min(previewItems.length, agentIndex + 1)}/${previewItems.length}`}
                  </text>
                )}
              </box>
            </box>
          </box>
        ) : (
          /* Compact Stack (e.g. 80x24): zero borders inside body so every section fits cleanly */
          <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            {/* 1. Plugin Name */}
            <box
              flexDirection="row"
              height={1}
              backgroundColor={focusedField === "name" ? THEME.bgRowFocus : THEME.bgInput}
              flexShrink={0}
              onMouseDown={() => onFocusField("name")}
            >
              <text width={16} height={1} wrapMode="none" flexShrink={0} style={{ textColor: focusedField === "name" ? accent : THEME.fgSecondary }} b>
                {focusedField === "name" ? "▎ Plugin Name:" : "  Plugin Name:"}
              </text>
              <input
                width={Math.max(10, layout.innerWidth - 16)}
                value={pluginName}
                placeholder="insert name"
                placeholderColor={THEME.fgMuted}
                focused={focusedField === "name"}
                onInput={onChangePluginName}
                onSubmit={onSubmit}
              />
            </box>

            {/* 2. Pack Selector */}
            <box flexDirection="column" flexShrink={0} onMouseDown={() => onFocusField("pack")}>
              <box
                flexDirection="row"
                height={1}
                backgroundColor={focusedField === "pack" ? THEME.bgRowFocus : "transparent"}
                flexShrink={0}
              >
                <text width={16} height={1} wrapMode="none" flexShrink={0} style={{ textColor: focusedField === "pack" ? accent : THEME.fgSecondary }} b>
                  {focusedField === "pack" ? "▎ Pack:" : "  Pack:"}
                </text>
                {focusedField === "pack" ? (
                  <input
                    width={Math.max(10, layout.innerWidth - 16)}
                    value={packQuery}
                    placeholder="type to filter packs..."
                    placeholderColor={THEME.fgMuted}
                    focused={true}
                    onInput={onChangePackQuery}
                    onSubmit={onSubmit}
                  />
                ) : (
                  <text width={Math.max(10, layout.innerWidth - 16)} height={1} wrapMode="none" overflow="hidden" style={{ textColor: selectedPack ? THEME.fgPrimary : THEME.accentRed }} b={Boolean(selectedPack)}>
                    {selectedPack
                      ? `${terminalSafeText(selectedPack)}${selectedPackInfo ? `  (${selectedPackInfo.count} agents)` : ""}${selectedPack === suggestedPack ? " · current" : ""}`
                      : "(no pack selected)"}
                  </text>
                )}
              </box>
              {focusedField === "pack" && renderPackList()}
            </box>

            {/* 3. Tiers */}
            <box flexDirection="column" flexShrink={0} onMouseDown={() => onFocusField("tiers")}>
              <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
                <text height={1} wrapMode="none" style={{ textColor: isTiersActive ? accent : THEME.fgSecondary }} b>
                  {isTiersActive ? `▎ Tiers (${target}):` : `  Tiers (${target}):`}
                </text>
                <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                  {target === "codex" && focusedField === "effort" ? "↑/↓ · ←/→ effort" : "↑/↓ tier · ←/→ model"}
                </text>
              </box>
              {renderTierRows(layout.innerWidth)}
            </box>

            {/* 4. Catch-all Model Override */}
            <box
              flexDirection="row"
              height={1}
              backgroundColor={focusedField === "model" ? THEME.bgRowFocus : THEME.bgInput}
              flexShrink={0}
              onMouseDown={() => onFocusField("model")}
            >
              <text width={16} height={1} wrapMode="none" flexShrink={0} style={{ textColor: focusedField === "model" ? accent : THEME.fgSecondary }} b>
                {focusedField === "model" ? "▎ Map all to:" : "  Map all to:"}
              </text>
              <input
                width={Math.max(10, layout.innerWidth - 16)}
                value={modelTarget}
                placeholder="empty = tier mapping"
                placeholderColor={THEME.fgMuted}
                focused={focusedField === "model"}
                onInput={onChangeModelTarget}
                onSubmit={onSubmit}
              />
            </box>

            {/* 5. Live Agent Mapping */}
            <box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden" onMouseDown={() => onFocusField("agents")}>
              <box flexDirection="row" justifyContent="space-between" height={1} flexShrink={0}>
                <text height={1} wrapMode="none" style={{ textColor: focusedField === "agents" ? accent : THEME.fgSecondary }} b>
                  {focusedField === "agents"
                    ? `▎ Mapping '${previewPackLabel}' (${previewItems.length}):`
                    : `  Mapping '${previewPackLabel}' (${previewItems.length}):`}
                </text>
                <text height={1} wrapMode="none" style={{ textColor: THEME.fgMuted }}>
                  ←/→ assign tier
                </text>
              </box>
              {renderAgentRows(layout.innerWidth)}
            </box>

            <text height={1} wrapMode="none" overflow="hidden" flexShrink={0} style={{ textColor: THEME.fgMuted }}>
              {middleEllipsis(`Source: '${previewPackLabel}' (strips '${strippedPrefix}') → bridges/${target === "codex" ? "codex" : "claude-code"}/${previewPluginSlug}/`, layout.innerWidth)}
            </text>
          </box>
        )}
      </box>

      {/* Footer */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        borderStyle="single"
        border={["top"]}
        borderColor={THEME.borderSubtle}
        paddingTop={layout.wide ? 1 : 0}
        flexShrink={0}
        overflow="hidden"
      >
        <text height={1} wrapMode="none" overflow="hidden" style={{ textColor: THEME.fgSecondary }}>
          {layout.wide
            ? `Section: ${focusedField} · TAB cycle · ${tiersDirty ? "Ctrl+S save tiers · " : ""}ENTER generate`
            : `${focusedField} · TAB · ${tiersDirty ? "^S tiers · " : ""}ENTER run`}
        </text>
        <box flexDirection="row" gap={2} flexShrink={0}>
          {tiersDirty && layout.wide && (
            <text height={1} wrapMode="none" style={{ textColor: THEME.accentGreen }} b onMouseDown={onSaveTiers}>
              [Ctrl+S] Save Tiers
            </text>
          )}
          <text height={1} wrapMode="none" style={{ textColor: THEME.accentRed }} b onMouseDown={onClose}>
            [ESC] Cancel
          </text>
        </box>
      </box>
    </box>
  )
}
