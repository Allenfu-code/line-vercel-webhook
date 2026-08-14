#!/usr/bin/env bash
set -euo pipefail

config_root="${XDG_CONFIG_HOME:-${HOME:?}/.config}"
credential_dir="${config_root}/line-webhook"
target_file="${credential_dir}/line-webhook.env"

install -d -m 0700 -- "${credential_dir}"

if [[ -e "${target_file}" ]]; then
  read -r -p "Replace the existing LINE credential file? [y/N] " confirmation
  if [[ "${confirmation}" != "y" && "${confirmation}" != "Y" ]]; then
    echo "Credential update cancelled."
    exit 0
  fi
fi

read -r -s -p "LINE channel access token: " channel_access_token
echo
read -r -s -p "LINE channel secret: " channel_secret
echo

if [[ ! "${channel_access_token}" =~ ^[A-Za-z0-9._~+/=-]+$ ]]; then
  echo "The access token is empty or contains unsupported characters." >&2
  exit 1
fi
if [[ ! "${channel_secret}" =~ ^[A-Fa-f0-9]{32}$ ]]; then
  echo "The channel secret must be the 32-character hexadecimal value from LINE Developers." >&2
  exit 1
fi

umask 077
temporary_file="$(mktemp "${credential_dir}/.line-webhook.env.XXXXXX")"
case "${temporary_file}" in
  "${credential_dir}"/.line-webhook.env.*) ;;
  *)
    echo "Unexpected temporary credential path." >&2
    exit 1
    ;;
esac

cleanup() {
  unset channel_access_token channel_secret
  if [[ -n "${temporary_file:-}" && -f "${temporary_file}" ]]; then
    rm -f -- "${temporary_file}"
  fi
}
trap cleanup EXIT

printf 'LINE_CHANNEL_ACCESS_TOKEN=%s\n' "${channel_access_token}" > "${temporary_file}"
printf 'LINE_CHANNEL_SECRET=%s\n' "${channel_secret}" >> "${temporary_file}"
chmod 0600 -- "${temporary_file}"
mv -f -- "${temporary_file}" "${target_file}"
temporary_file=""

echo "LINE credentials saved outside the repository with mode 0600. Values were not displayed."
