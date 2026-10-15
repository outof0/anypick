import SwiftUI

struct MenuBarFirstRun: View {
  @ObservedObject var model: MacOSDesignModel
  var openAccounts: () -> Void

  var body: some View {
    VStack(spacing: 9) {
      VStack(spacing: 6) {
        ZStack {
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(TrayPaint.accent)
            .frame(width: 44, height: 44)
          Image(systemName: "sparkle")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(.white)
        }
        Text(model.localized(model.currentLiveLogin == nil ? "desktop.menu_bar.add_login_to_start" : "desktop.menu_bar.save_login_to_start"))
          .font(.system(size: 17, weight: .semibold))
        Text(firstRunDescription)
          .font(.system(size: 11))
          .foregroundStyle(.secondary)
      }
      .padding(.top, 4)
      .padding(.horizontal, 8)

      if let login = model.currentLiveLogin {
        HStack(spacing: 10) {
          DesignProviderIcon(provider: login.providerID, fallbackSymbol: login.symbol, size: 32)
          VStack(alignment: .leading, spacing: 2) {
            Text(login.appName)
              .font(.system(size: 12, weight: .semibold))
            Text(login.identity ?? model.localized("desktop.menu_bar.current_login_detected"))
              .font(TrayFont.detail)
              .foregroundStyle(.secondary)
          }
          Spacer(minLength: 6)
          HStack(spacing: 4) {
            Circle().fill(TrayPaint.ready).frame(width: 6, height: 6)
            Text(model.localized("desktop.published.active"))
              .font(TrayFont.detailStrong)
              .foregroundStyle(TrayPaint.ready)
          }
          .padding(.horizontal, 6)
          .frame(height: 20)
          .background(
            TrayPaint.ready.opacity(0.12),
            in: RoundedRectangle(cornerRadius: 6, style: .continuous)
          )
        }
        .padding(10)
        .frame(height: 62)
        .background(TrayPaint.cardFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .strokeBorder(TrayPaint.hairline, lineWidth: 0.5)
        )
      }

      if let login = model.currentLiveLogin {
        VStack(alignment: .leading, spacing: 7) {
          trustRow(model.localized("desktop.menu_bar.trust_keep_signed_in", replacing: ["app": login.appName]))
          trustRow(model.localized("desktop.menu_bar.trust_encrypted_snapshot"))
          trustRow(model.localized("desktop.menu_bar.trust_remove_replace"))
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          TrayPaint.accent.opacity(0.12),
          in: RoundedRectangle(cornerRadius: 10, style: .continuous)
        )
      }

      Button(action: saveDetected) {
        HStack(spacing: 7) {
          if model.isBusy {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: model.currentLiveLogin == nil ? "person.badge.plus" : "square.and.arrow.down")
          }
          Text(model.localized(model.currentLiveLogin == nil ? "desktop.menu_bar.add_login_action" : "desktop.menu_bar.save_this_login"))
        }
        .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(model.isBusy)
      .accessibilityIdentifier("tray.first-run.save")

      if model.currentLiveLogin != nil {
        Button(action: openAccounts) {
          Text(model.localized("desktop.menu_bar.choose_another_login"))
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
      }

      HStack(spacing: 8) {
        stepBadge(1, current: true)
        Text(model.localized(model.currentLiveLogin == nil ? "desktop.menu_bar.add_login_step" : "desktop.menu_bar.save_login_step"))
          .font(TrayFont.detailStrong)
        Rectangle()
          .fill(Color.primary.opacity(0.18))
          .frame(height: 1)
        stepBadge(2, current: false)
        Text(model.localized("desktop.menu_bar.point_an_app"))
          .font(TrayFont.detailStrong)
          .foregroundStyle(.secondary)
      }
      .padding(.top, 3)
      .padding(.horizontal, 2)
    }
  }

  private func trustRow(_ text: String) -> some View {
    HStack(alignment: .center, spacing: 7) {
      Image(systemName: "checkmark.circle")
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(TrayPaint.accent)
      Text(text)
        .font(TrayFont.detailMedium)
        .foregroundStyle(TrayPaint.accentInk)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(height: 19, alignment: .leading)
  }

  private func stepBadge(_ number: Int, current: Bool) -> some View {
    Text("\(number)")
      .font(TrayFont.detailStrong)
      .foregroundStyle(current ? Color.white : Color.secondary)
      .frame(width: 18, height: 18)
      .background(
        current ? Color.primary : Color.primary.opacity(0.15),
        in: Circle()
      )
  }

  private func saveDetected() {
    guard let login = model.currentLiveLogin else {
      openAccounts()
      return
    }
    _ = model.saveCurrentLogin(login)
  }

  private var firstRunDescription: String {
    guard let login = model.currentLiveLogin else {
      return model.localized("desktop.menu_bar.first_run_signin")
    }
    return model.localized("desktop.menu_bar.active_login_found", replacing: ["app": login.appName])
  }
}
