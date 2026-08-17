import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type SongwriterPlugin from "./main";
import { SongwriterSettings } from "./types";
import { t } from "./i18n";

export class SongwriterSettingTab extends PluginSettingTab {
  plugin: SongwriterPlugin;

  constructor(app: App, plugin: SongwriterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName(t("setPickupName"))
      .setDesc(t("setPickupDesc"))
      .addDropdown(dropdown => dropdown
        .addOption("hybrid", t("pickupHybrid"))
        .addOption("auto", t("pickupAuto"))
        .addOption("manual", t("pickupManual"))
        .setValue(this.plugin.settings.pickupMode)
        .onChange(async (value) => {
          this.plugin.settings.pickupMode = value as SongwriterSettings["pickupMode"];
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setSkipName"))
      .setDesc(t("setSkipDesc"))
      .addSlider(slider => slider
        .setLimits(1, 30, 1)
        .setValue(this.plugin.settings.skipSeconds)
        .onChange(async (value) => {
          this.plugin.settings.skipSeconds = value;
          this.plugin.refreshViews();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setStartMarkerName"))
      .setDesc(t("setStartMarkerDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.startFromMarkerOnLoad)
        .onChange(async (value) => {
          this.plugin.settings.startFromMarkerOnLoad = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName(t("headingPlaylist")).setHeading();

    new Setting(containerEl)
      .setName(t("setFolderQueueName"))
      .setDesc(t("setFolderQueueDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.folderQueue)
        .onChange(async (value) => {
          this.plugin.settings.folderQueue = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setAutoAdvanceName"))
      .setDesc(t("setAutoAdvanceDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoAdvance)
        .onChange(async (value) => {
          this.plugin.settings.autoAdvance = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName(t("headingMusical")).setHeading();

    new Setting(containerEl)
      .setName(t("setAutoAnalyseName"))
      .setDesc(t("setAutoAnalyseDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoAnalyse)
        .onChange(async (value) => {
          this.plugin.settings.autoAnalyse = value;
          await this.plugin.saveSettings();
        }));

    const windowSetting = new Setting(containerEl).setName(t("setTempoWindowName"));
    const describeWindow = () => windowSetting.setDesc(
      t("setTempoWindowDesc")(this.plugin.settings.tempoWindowLow, this.plugin.settings.tempoWindowLow * 2 - 1)
    );
    describeWindow();
    windowSetting.addSlider(slider => slider
      .setLimits(40, 120, 5)
      .setDynamicTooltip()
      .setValue(this.plugin.settings.tempoWindowLow)
      .onChange(async (value) => {
        this.plugin.settings.tempoWindowLow = value;
        describeWindow();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl).setName(t("headingHotkeys")).setHeading();

    new Setting(containerEl)
      .setName(t("setHotkeysName"))
      .setDesc(t("setHotkeysDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.defaultHotkeys)
        .onChange(async (value) => {
          this.plugin.settings.defaultHotkeys = value;
          await this.plugin.saveSettings();
          // live, so trying a key out costs a keystroke instead of a restart
          if (this.plugin.applyDefaultHotkeys()) {
            new Notice(value ? t("hotkeysOn") : t("hotkeysOff"), 4000);
          } else {
            new Notice(t("hotkeysReloadHint"), 6000);
          }
        }));

    new Setting(containerEl).setName(t("headingFine")).setHeading();

    // desktop only: on mobile the WebView never reaches the system media
    // controls (see mediasession.ts), so the toggle would promise nothing
    if (Platform.isDesktop) {
      new Setting(containerEl)
        .setName(t("setMediaKeysName"))
        .setDesc(t("setMediaKeysDesc"))
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.mediaKeys)
          .onChange(async (value) => {
            this.plugin.settings.mediaKeys = value;
            this.plugin.mediaSession.applyEnabled();
            await this.plugin.saveSettings();
          }));
    }

    new Setting(containerEl)
      .setName(t("setPlayCountName"))
      .setDesc(t("setPlayCountDesc"))
      .addSlider(slider => slider
        .setLimits(1, 30, 1)
        .setValue(this.plugin.settings.playCountSec)
        .onChange(async (value) => {
          this.plugin.settings.playCountSec = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setDoubleStopName"))
      .setDesc(t("setDoubleStopDesc"))
      .addSlider(slider => slider
        .setLimits(300, 1500, 50)
        .setValue(this.plugin.settings.doubleStopMs)
        .onChange(async (value) => {
          this.plugin.settings.doubleStopMs = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setWaveHName"))
      .setDesc(t("setWaveHDesc"))
      .addSlider(slider => slider
        .setLimits(60, 220, 10)
        .setValue(this.plugin.settings.waveHeight)
        .onChange(async (value) => {
          this.plugin.settings.waveHeight = value;
          this.plugin.refreshViews();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setInlineName"))
      .setDesc(t("setInlineDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.inlinePlayers)
        .onChange(async (value) => {
          this.plugin.settings.inlinePlayers = value;
          this.plugin.embeds.applyMode();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName(t("setEmbedBtnName"))
      .setDesc(t("setEmbedBtnDesc"))
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.embedButtons)
        .onChange(async (value) => {
          this.plugin.settings.embedButtons = value;
          this.plugin.embeds.applyVisibility();
          await this.plugin.saveSettings();
        }));

    if (Platform.isMobile) {
      new Setting(containerEl)
        .setName(t("setFabName"))
        .setDesc(t("setFabDesc"))
        .addToggle(toggle => toggle
          .setValue(this.plugin.settings.mobileFab)
          .onChange(async (value) => {
            this.plugin.settings.mobileFab = value;
            this.plugin.mobileFab.applyVisibility();
            await this.plugin.saveSettings();
          }));

      new Setting(containerEl)
        .setName(t("setFabModeName"))
        .setDesc(t("setFabModeDesc"))
        .addDropdown(dropdown => dropdown
          .addOption("marker", t("fabModeMarker"))
          .addOption("smart", t("fabModeSmart"))
          .setValue(this.plugin.settings.fabMode)
          .onChange(async (value) => {
            this.plugin.settings.fabMode = value as SongwriterSettings["fabMode"];
            this.plugin.mobileFab.applyVisibility(); // refresh the icon
            await this.plugin.saveSettings();
          }));
    }
  }
}
