import type { MessageKey } from '@shared/locales/en-US'

export interface GuideCommand {
  labelKey?: MessageKey
  cmd: string
}

export interface GuideSection {
  titleKey: MessageKey
  commands: GuideCommand[]
  noteKey?: MessageKey
}

export interface PlatformGuide {
  summaryKey: MessageKey
  format: string
  sections: GuideSection[]
}

const SPECIFIC: Record<string, PlatformGuide> = {
  gh: {
    summaryKey: 'development.xget.guide.gh.summary',
    format: "{proxy}/gh/<owner>/<repo>/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.gh.s0.title',
        commands: [
          { labelKey: 'development.xget.guide.gh.s0.c0.label', cmd: "git clone {proxy}/gh/owner/repo.git" },
          { labelKey: 'development.xget.guide.gh.s0.c1.label', cmd: "git clone --depth 1 {proxy}/gh/owner/repo.git" },
          { labelKey: 'development.xget.guide.gh.s0.c2.label', cmd: "git clone -b main {proxy}/gh/facebook/react.git" },
        ],
      },
      {
        titleKey: 'development.xget.guide.gh.s1.title',
        commands: [
          { labelKey: 'development.xget.guide.gh.s1.c0.label', cmd: "git config --global url.\"{proxy}/gh/\".insteadOf \"https://github.com/\"" },
          { labelKey: 'development.xget.guide.gh.s1.c1.label', cmd: "git config --global --get-regexp url" },
        ],
        noteKey: 'development.xget.guide.gh.s1.note',
      },
      {
        titleKey: 'development.xget.guide.gh.s2.title',
        commands: [
          { labelKey: 'development.xget.guide.gh.s2.c0.label', cmd: "wget -c \"{proxy}/gh/owner/repo/archive/refs/heads/main.zip\"" },
          { labelKey: 'development.xget.guide.gh.s2.c1.label', cmd: "curl -L -O \"{proxy}/gh/owner/repo/releases/download/v1.0.0/file.tar.gz\"" },
          { labelKey: 'development.xget.guide.gh.s2.c2.label', cmd: "aria2c -x 16 -s 16 \"{proxy}/gh/owner/repo/archive/refs/tags/v1.0.0.tar.gz\"" },
        ],
      },
    ],
  },
  gist: {
    summaryKey: 'development.xget.guide.gist.summary',
    format: "{proxy}/gist/<user>/<gist-id>/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.gist.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/gist/user/gist-id/raw/hash/file.md\"" },
        ],
      },
      {
        titleKey: 'development.xget.guide.gist.s1.title',
        commands: [
          { cmd: "git clone {proxy}/gist/user/gist-id.git" },
        ],
      },
    ],
  },
  gl: {
    summaryKey: 'development.xget.guide.gl.summary',
    format: "{proxy}/gl/<group>/<project>/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.gl.s0.title',
        commands: [
          { cmd: "git clone {proxy}/gl/gitlab-org/gitlab.git" },
        ],
      },
      {
        titleKey: 'development.xget.guide.gl.s1.title',
        commands: [
          { cmd: "curl -L -O \"{proxy}/gl/gitlab-org/gitlab/-/archive/master/gitlab-master.zip\"" },
        ],
      },
      {
        titleKey: 'development.xget.guide.gl.s2.title',
        commands: [
          { cmd: "git config --global url.\"{proxy}/gl/\".insteadOf \"https://gitlab.com/\"" },
        ],
      },
    ],
  },
  hf: {
    summaryKey: 'development.xget.guide.hf.summary',
    format: "{proxy}/hf/<owner>/<model>/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.hf.s0.title',
        commands: [
          { cmd: "export HF_ENDPOINT='{proxy}/hf'" },
        ],
        noteKey: 'development.xget.guide.hf.s0.note',
      },
      {
        titleKey: 'development.xget.guide.hf.s1.title',
        commands: [
          { cmd: "wget -c \"{proxy}/hf/microsoft/DialoGPT-medium/resolve/main/pytorch_model.bin\"" },
        ],
      },
      {
        titleKey: 'development.xget.guide.hf.s2.title',
        commands: [
          { cmd: "curl -L -O \"{proxy}/hf/datasets/rajpurkar/squad/resolve/main/plain_text/train-00000-of-00001.parquet\"" },
        ],
      },
    ],
  },
  npm: {
    summaryKey: 'development.xget.guide.npm.summary',
    format: "{proxy}/npm/<package>/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.npm.s0.title',
        commands: [
          { cmd: "npm install --registry {proxy}/npm/" },
        ],
      },
      {
        titleKey: 'development.xget.guide.npm.s1.title',
        commands: [
          { labelKey: 'development.xget.guide.npm.s1.c0.label', cmd: "npm config set registry {proxy}/npm/" },
          { labelKey: 'development.xget.guide.npm.s1.c1.label', cmd: "npm config get registry" },
        ],
      },
      {
        titleKey: 'development.xget.guide.npm.s2.title',
        commands: [
          { cmd: "[install]\nregistry = \"{proxy}/npm/\"" },
        ],
      },
      {
        titleKey: 'development.xget.guide.npm.s3.title',
        commands: [
          { cmd: "wget -c \"{proxy}/npm/react/-/react-18.2.0.tgz\"" },
        ],
      },
    ],
  },
  pypi: {
    summaryKey: 'development.xget.guide.pypi.summary',
    format: "{proxy}/pypi/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.pypi.s0.title',
        commands: [
          { cmd: "pip install requests -i {proxy}/pypi/simple/" },
        ],
      },
      {
        titleKey: 'development.xget.guide.pypi.s1.title',
        commands: [
          { cmd: "pip config set global.index-url {proxy}/pypi/simple/" },
          { labelKey: 'development.xget.guide.pypi.s1.c1.label', cmd: "pip config set global.trusted-host {proxyHostname}" },
        ],
      },
      {
        titleKey: 'development.xget.guide.pypi.s2.title',
        commands: [
          { cmd: "--index-url {proxy}/pypi/simple/\n--trusted-host {proxyHostname}\n\nrequests>=2.25.0" },
        ],
      },
    ],
  },
  conda: {
    summaryKey: 'development.xget.guide.conda.summary',
    format: "{proxy}/conda/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.conda.s0.title',
        commands: [
          { cmd: "conda config --add default_channels {proxy}/conda/pkgs/main" },
          { cmd: "conda config --add default_channels {proxy}/conda/pkgs/r" },
        ],
      },
      {
        titleKey: 'development.xget.guide.conda.s1.title',
        commands: [
          { cmd: "conda config --set channel_alias {proxy}/conda/community" },
        ],
      },
      {
        titleKey: 'development.xget.guide.conda.s2.title',
        commands: [
          { cmd: "conda config --add channels {proxy}/conda/community/conda-forge" },
        ],
      },
    ],
  },
  maven: {
    summaryKey: 'development.xget.guide.maven.summary',
    format: "{proxy}/maven/maven2/<groupId>/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.maven.s0.title',
        commands: [
          { cmd: "<mirror>\n  <id>xget</id>\n  <mirrorOf>central</mirrorOf>\n  <url>{proxy}/maven/maven2</url>\n</mirror>" },
        ],
      },
      {
        titleKey: 'development.xget.guide.maven.s1.title',
        commands: [
          { cmd: "mvn dependency:get -Dartifact=org.springframework:spring-core:5.3.21 -DremoteRepositories={proxy}/maven/maven2" },
        ],
      },
      {
        titleKey: 'development.xget.guide.maven.s2.title',
        commands: [
          { cmd: "wget -c \"{proxy}/maven/maven2/org/springframework/spring-core/5.3.21/spring-core-5.3.21.jar\"" },
        ],
      },
    ],
  },
  gradle: {
    summaryKey: 'development.xget.guide.gradle.summary',
    format: "{proxy}/gradle/m2/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.gradle.s0.title',
        commands: [
          { cmd: "repositories {\n    maven { url '{proxy}/maven/maven2' }\n    gradlePluginPortal { url '{proxy}/gradle/m2' }\n}" },
        ],
      },
      {
        titleKey: 'development.xget.guide.gradle.s1.title',
        commands: [
          { cmd: "pluginManagement {\n    repositories {\n        maven { url '{proxy}/gradle/m2' }\n    }\n}" },
        ],
      },
    ],
  },
  homebrew: {
    summaryKey: 'development.xget.guide.homebrew.summary',
    format: "{proxy}/homebrew/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.homebrew.s0.title',
        commands: [
          { cmd: "export HOMEBREW_BREW_GIT_REMOTE=\"{proxy}/homebrew/brew.git\"" },
          { cmd: "export HOMEBREW_CORE_GIT_REMOTE=\"{proxy}/homebrew/homebrew-core.git\"" },
          { cmd: "export HOMEBREW_API_DOMAIN=\"{proxy}/homebrew/api\"" },
          { cmd: "export HOMEBREW_BOTTLE_DOMAIN=\"{proxy}/homebrew/bottles\"" },
        ],
      },
      {
        titleKey: 'development.xget.guide.homebrew.s1.title',
        commands: [
          { cmd: "echo 'export HOMEBREW_BOTTLE_DOMAIN=\"{proxy}/homebrew/bottles\"' >> ~/.zprofile" },
        ],
      },
    ],
  },
  rubygems: {
    summaryKey: 'development.xget.guide.rubygems.summary',
    format: "{proxy}/rubygems/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.rubygems.s0.title',
        commands: [
          { cmd: "gem install rails --source {proxy}/rubygems/" },
        ],
      },
      {
        titleKey: 'development.xget.guide.rubygems.s1.title',
        commands: [
          { cmd: "gem sources --add {proxy}/rubygems/" },
          { cmd: "gem sources --remove https://rubygems.org/" },
        ],
      },
      {
        titleKey: 'development.xget.guide.rubygems.s2.title',
        commands: [
          { cmd: "bundle config mirror.https://rubygems.org {proxy}/rubygems/" },
        ],
      },
    ],
  },
  cran: {
    summaryKey: 'development.xget.guide.cran.summary',
    format: "{proxy}/cran/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.cran.s0.title',
        commands: [
          { cmd: "install.packages(\"ggplot2\", repos = \"{proxy}/cran/\")" },
        ],
      },
      {
        titleKey: 'development.xget.guide.cran.s1.title',
        commands: [
          { cmd: "options(repos = c(CRAN = \"{proxy}/cran/\"))" },
        ],
      },
      {
        titleKey: 'development.xget.guide.cran.s2.title',
        commands: [
          { cmd: "Rscript -e \"options(repos = c(CRAN = '{proxy}/cran/')); install.packages('dplyr')\"" },
        ],
      },
    ],
  },
  cpan: {
    summaryKey: 'development.xget.guide.cpan.summary',
    format: "{proxy}/cpan/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.cpan.s0.title',
        commands: [
          { cmd: "cpan o conf urllist push {proxy}/cpan/" },
          { cmd: "cpan o conf commit" },
        ],
      },
      {
        titleKey: 'development.xget.guide.cpan.s1.title',
        commands: [
          { cmd: "cpanm --mirror {proxy}/cpan/ DBI" },
        ],
      },
    ],
  },
  ctan: {
    summaryKey: 'development.xget.guide.ctan.summary',
    format: "{proxy}/ctan/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.ctan.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/ctan/tex-archive/macros/latex/contrib/beamer.zip\"" },
        ],
      },
    ],
  },
  golang: {
    summaryKey: 'development.xget.guide.golang.summary',
    format: "{proxy}/golang/<module>/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.golang.s0.title',
        commands: [
          { cmd: "go env -w GOPROXY={proxy}/golang,direct" },
        ],
      },
      {
        titleKey: 'development.xget.guide.golang.s1.title',
        commands: [
          { cmd: "wget -c \"{proxy}/golang/github.com/gin-gonic/gin/@v/v1.9.1.zip\"" },
        ],
      },
    ],
  },
  nuget: {
    summaryKey: 'development.xget.guide.nuget.summary',
    format: "{proxy}/nuget/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.nuget.s0.title',
        commands: [
          { cmd: "dotnet nuget add source {proxy}/nuget/v3/index.json -n xget" },
        ],
      },
      {
        titleKey: 'development.xget.guide.nuget.s1.title',
        commands: [
          { cmd: "wget -c \"{proxy}/nuget/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg\"" },
        ],
      },
    ],
  },
  crates: {
    summaryKey: 'development.xget.guide.crates.summary',
    format: "{proxy}/crates/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.crates.s0.title',
        commands: [
          { cmd: "curl -L -O \"{proxy}/crates/api/v1/crates/serde/1.0.0/download\"" },
        ],
      },
      {
        titleKey: 'development.xget.guide.crates.s1.title',
        commands: [
          { cmd: "curl -s \"{proxy}/crates/api/v1/crates/serde\"" },
        ],
      },
    ],
  },
  packagist: {
    summaryKey: 'development.xget.guide.packagist.summary',
    format: "{proxy}/packagist/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.packagist.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/packagist/p2/symfony/console.json\"" },
        ],
      },
    ],
  },
  flathub: {
    summaryKey: 'development.xget.guide.flathub.summary',
    format: "{proxy}/flathub/repo/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.flathub.s0.title',
        commands: [
          { cmd: "flatpak install --from {proxy}/flathub/repo/appstream/org.gnome.gedit.flatpakref" },
        ],
      },
      {
        titleKey: 'development.xget.guide.flathub.s1.title',
        commands: [
          { cmd: "wget -c \"{proxy}/flathub/repo/summary\"" },
        ],
      },
    ],
  },
  debian: {
    summaryKey: 'development.xget.guide.debian.summary',
    format: "{proxy}/debian/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.debian.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/debian/debian/pool/main/c/curl/curl_7.88.1-10+deb12u4_amd64.deb\"" },
        ],
      },
    ],
  },
  ubuntu: {
    summaryKey: 'development.xget.guide.ubuntu.summary',
    format: "{proxy}/ubuntu/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.ubuntu.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/ubuntu/ubuntu/pool/main/g/git/git_2.34.1-1ubuntu1.9_amd64.deb\"" },
        ],
      },
    ],
  },
  fedora: {
    summaryKey: 'development.xget.guide.fedora.summary',
    format: "{proxy}/fedora/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.fedora.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/fedora/releases/39/Everything/x86_64/os/Packages/n/nginx-1.24.0-1.fc39.x86_64.rpm\"" },
        ],
      },
    ],
  },
  rocky: {
    summaryKey: 'development.xget.guide.rocky.summary',
    format: "{proxy}/rocky/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.rocky.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/rocky/pub/rocky/9/BaseOS/x86_64/os/Packages/b/bash-5.1.8-6.el9.x86_64.rpm\"" },
        ],
      },
    ],
  },
  opensuse: {
    summaryKey: 'development.xget.guide.opensuse.summary',
    format: "{proxy}/opensuse/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.opensuse.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/opensuse/distribution/leap/15.5/repo/oss/x86_64/vim-9.0.1572-150500.20.8.1.x86_64.rpm\"" },
        ],
      },
    ],
  },
  arch: {
    summaryKey: 'development.xget.guide.arch.summary',
    format: "{proxy}/arch/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.arch.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/arch/core/os/x86_64/linux-6.6.10.arch1-1-x86_64.pkg.tar.zst\"" },
        ],
      },
    ],
  },
  arxiv: {
    summaryKey: 'development.xget.guide.arxiv.summary',
    format: "{proxy}/arxiv/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.arxiv.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/arxiv/pdf/2301.07041.pdf\"" },
        ],
      },
      {
        titleKey: 'development.xget.guide.arxiv.s1.title',
        commands: [
          { cmd: "curl -L -O \"{proxy}/arxiv/e-print/2301.07041\"" },
        ],
      },
    ],
  },
  fdroid: {
    summaryKey: 'development.xget.guide.fdroid.summary',
    format: "{proxy}/fdroid/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.fdroid.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/fdroid/repo/org.fdroid.fdroid_1016050.apk\"" },
        ],
      },
      {
        titleKey: 'development.xget.guide.fdroid.s1.title',
        commands: [
          { cmd: "curl -s \"{proxy}/fdroid/api/v1/packages/org.fdroid.fdroid\"" },
        ],
      },
    ],
  },
  jenkins: {
    summaryKey: 'development.xget.guide.jenkins.summary',
    format: "{proxy}/jenkins/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.jenkins.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/jenkins/download/plugins/maven-plugin/3.27/maven-plugin.hpi\"" },
        ],
      },
      {
        titleKey: 'development.xget.guide.jenkins.s1.title',
        commands: [
          { cmd: "curl -s \"{proxy}/jenkins/update-center.json\"" },
        ],
      },
    ],
  },
  apache: {
    summaryKey: 'development.xget.guide.apache.summary',
    format: "{proxy}/apache/<project>/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.apache.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/apache/kafka/3.6.1/kafka_2.13-3.6.1.tgz\"" },
          { cmd: "curl -L -O \"{proxy}/apache/maven/maven-3/3.9.5/binaries/apache-maven-3.9.5-bin.tar.gz\"" },
        ],
      },
    ],
  },
  sf: {
    summaryKey: 'development.xget.guide.sf.summary',
    format: "{proxy}/sf/projects/<project>/files/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.sf.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/sf/projects/sevenzip/files/7-Zip/23.01/7z2301-x64.exe/download\"" },
        ],
      },
      {
        titleKey: 'development.xget.guide.sf.s1.title',
        commands: [
          { cmd: "git clone {proxy}/sf/projects/mingw-w64/code.git" },
        ],
      },
    ],
  },
  aosp: {
    summaryKey: 'development.xget.guide.aosp.summary',
    format: "{proxy}/aosp/<project>/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.aosp.s0.title',
        commands: [
          { cmd: "git clone {proxy}/aosp/platform/frameworks/base.git" },
        ],
      },
      {
        titleKey: 'development.xget.guide.aosp.s1.title',
        commands: [
          { cmd: "git config --global url.\"{proxy}/aosp/\".insteadOf \"https://android.googlesource.com/\"" },
        ],
      },
    ],
  },
  civitai: {
    summaryKey: 'development.xget.guide.civitai.summary',
    format: "{proxy}/civitai/<path>",
    sections: [
      {
        titleKey: 'development.xget.guide.civitai.s0.title',
        commands: [
          { cmd: "wget -c \"{proxy}/civitai/api/download/models/128713\"" },
        ],
      },
      {
        titleKey: 'development.xget.guide.civitai.s1.title',
        commands: [
          { cmd: "curl -s \"{proxy}/civitai/api/v1/models/7240\"" },
        ],
      },
    ],
  },
}

function categoryGuide(key: string): PlatformGuide {
  if (key.startsWith('cr-')) {
    const registry = key.slice(3)
    return {
      summaryKey: 'development.xget.guide.category.registry.summary',
      format: `{proxy}/cr/${registry}/v2/<repo>/<tag>`,
      sections: [
        {
          titleKey: 'development.xget.guide.category.registry.s0.title',
          commands: [
            { cmd: `# /etc/docker/daemon.json\n{ "registry-mirrors": ["{proxy}/cr/${registry}"] }` },
            { cmd: 'sudo systemctl restart docker' },
          ],
          noteKey: 'development.xget.guide.category.registry.s0.note',
        },
        {
          titleKey: 'development.xget.guide.category.registry.s1.title',
          commands: [{ cmd: 'docker pull <image>:<tag>' }],
          noteKey: 'development.xget.guide.category.registry.s1.note',
        },
      ],
    }
  }
  if (key.startsWith('ip-')) {
    const endpoint = key.slice(3)
    return {
      summaryKey: 'development.xget.guide.category.ai.summary',
      format: `{proxy}/ip/${endpoint}/<api-path>`,
      sections: [
        {
          titleKey: 'development.xget.guide.category.ai.s0.title',
          commands: [{ cmd: `base_url = "{proxy}/ip/${endpoint}"` }],
        },
        {
          titleKey: 'development.xget.guide.category.ai.s1.title',
          commands: [
            {
              cmd:
                `curl -s "{proxy}/ip/${endpoint}/v1/chat/completions" \\\n` +
                `  -H "Authorization: Bearer $API_KEY" \\\n` +
                `  -H "Content-Type: application/json" \\\n` +
                `  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'`,
            },
          ],
          noteKey: 'development.xget.guide.category.ai.s1.note',
        },
      ],
    }
  }
  const prefix = key.replace(/-/g, '/')
  return {
    summaryKey: 'development.xget.guide.category.generic.summary',
    format: `{proxy}/${prefix}/<path>`,
    sections: [
      {
        titleKey: 'development.xget.guide.category.generic.s0.title',
        commands: [{ cmd: `https://<host>/<path>\n-> {proxy}/${prefix}/<path>` }],
      },
      {
        titleKey: 'development.xget.guide.category.generic.s1.title',
        commands: [
          { labelKey: 'development.xget.guide.category.generic.s1.c0.label', cmd: `wget -c "{proxy}/${prefix}<original-path>"` },
          { labelKey: 'development.xget.guide.category.generic.s1.c1.label', cmd: `curl -L -O "{proxy}/${prefix}<original-path>"` },
          { labelKey: 'development.xget.guide.category.generic.s1.c2.label', cmd: `aria2c -x 16 -s 16 "{proxy}/${prefix}<original-path>"` },
        ],
      },
    ],
  }
}

export function getPlatformGuide(key: string, _name: string): PlatformGuide {
  return SPECIFIC[key] ?? categoryGuide(key)
}

function proxyHostname(proxyBase: string): string {
  return new URL(proxyBase).host
}

export function renderGuideCommand(command: string, proxyBase: string): string {
  const base = proxyBase.replace(/\/+$/, '')
  const hostname = proxyHostname(base)
  return command.split('{proxyHostname}').join(hostname).split('{proxy}').join(base)
}
