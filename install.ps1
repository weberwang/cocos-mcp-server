param(
    [string]$RepoOwner = 'weberwang',
    [string]$RepoName = 'cocos-mcp-server',
    [string]$ProjectPath = $env:COCOS_PROJECT_PATH
)

$ErrorActionPreference = 'Stop'

# 函数：解析目标项目目录；未传环境变量时默认安装到当前执行目录。
function Resolve-TargetProjectPath {
    param(
        [string]$InputPath
    )

    if ([string]::IsNullOrWhiteSpace($InputPath)) {
        return (Get-Location).Path
    }

    if (-not (Test-Path -LiteralPath $InputPath)) {
        throw "目标项目目录不存在: $InputPath"
    }

    $resolvedPath = Resolve-Path -LiteralPath $InputPath
    if (-not $resolvedPath) {
        throw "无法解析目标项目目录: $InputPath"
    }

    $resolvedItem = Get-Item -LiteralPath $resolvedPath.Path
    if (-not $resolvedItem.PSIsContainer) {
        throw "目标项目路径不是目录: $($resolvedPath.Path)"
    }

    return $resolvedItem.FullName
}

# 函数：读取 GitHub 仓库默认分支，避免安装脚本依赖固定分支名。
function Get-DefaultBranch {
    param(
        [string]$Owner,
        [string]$Repo
    )

    $apiUrl = "https://api.github.com/repos/$Owner/$Repo"
    $headers = @{ 'User-Agent' = 'cocos-mcp-installer' }
    $response = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Get

    if (-not $response.default_branch) {
        throw "GitHub API 未返回默认分支 default_branch: $apiUrl"
    }

    return [string]$response.default_branch
}

# 函数：统一创建临时目录，确保下载和解压过程不会污染项目目录。
function New-InstallerTempRoot {
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cocos-mcp-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    return $tempRoot
}

# 函数：定位解压后的仓库根目录，并校验压缩包结构没有损坏。
function Resolve-ArchiveRoot {
    param(
        [string]$ExtractRoot,
        [string]$ZipUrl
    )

    $archiveDirs = Get-ChildItem -LiteralPath $ExtractRoot -Directory
    if ($archiveDirs.Count -eq 0) {
        throw "压缩包解压后没有找到仓库目录: $ZipUrl"
    }

    if ($archiveDirs.Count -gt 1) {
        throw "压缩包解压后出现多个顶层目录，结构异常: $ZipUrl"
    }

    return $archiveDirs[0]
}

# 函数：用新目录和备份目录做原子切换，避免复制失败时破坏已有安装。
function Replace-PluginDirectoryAtomically {
    param(
        [string]$SourceDir,
        [string]$TargetExtensionsDir
    )

    $targetDir = Join-Path $TargetExtensionsDir 'cocos-mcp-server'
    $newDir = Join-Path $TargetExtensionsDir 'cocos-mcp-server.__new__'
    $backupDir = Join-Path $TargetExtensionsDir 'cocos-mcp-server.__backup__'
    $hasBackup = $false
    $promoted = $false

    if (Test-Path -LiteralPath $newDir) {
        Remove-Item -LiteralPath $newDir -Recurse -Force
    }

    if (Test-Path -LiteralPath $backupDir) {
        Remove-Item -LiteralPath $backupDir -Recurse -Force
    }

    # 先复制到临时新目录，复制阶段失败时正式目录仍保持可用。
    Copy-Item -LiteralPath $SourceDir -Destination $newDir -Recurse

    try {
        if (Test-Path -LiteralPath $targetDir) {
            Move-Item -LiteralPath $targetDir -Destination $backupDir
            $hasBackup = $true
        }

        Move-Item -LiteralPath $newDir -Destination $targetDir
        $promoted = $true

        if ($hasBackup -and (Test-Path -LiteralPath $backupDir)) {
            Remove-Item -LiteralPath $backupDir -Recurse -Force
        }
    } catch {
        # 切换阶段失败时优先回滚旧目录，避免用户项目落到半安装状态。
        if (-not $promoted -and $hasBackup -and -not (Test-Path -LiteralPath $targetDir) -and (Test-Path -LiteralPath $backupDir)) {
            Move-Item -LiteralPath $backupDir -Destination $targetDir
        }

        throw
    } finally {
        if (Test-Path -LiteralPath $newDir) {
            Remove-Item -LiteralPath $newDir -Recurse -Force
        }

        if ($promoted -and (Test-Path -LiteralPath $backupDir)) {
            Remove-Item -LiteralPath $backupDir -Recurse -Force
        }
    }
}

# 函数：从 GitHub 默认分支安装 plugin-package 到 Creator 项目 extensions 目录。
function Install-PluginPackage {
    param(
        [string]$Owner,
        [string]$Repo,
        [string]$TargetProjectPath
    )

    $branch = Get-DefaultBranch -Owner $Owner -Repo $Repo
    $zipUrl = "https://github.com/$Owner/$Repo/archive/refs/heads/$branch.zip"
    $tempRoot = New-InstallerTempRoot
    $zipPath = Join-Path $tempRoot 'archive.zip'
    $extractRoot = Join-Path $tempRoot 'extract'
    $targetExtensionsDir = Join-Path $TargetProjectPath 'extensions'
    $targetDir = Join-Path $targetExtensionsDir 'cocos-mcp-server'

    New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null

    try {
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -Headers @{ 'User-Agent' = 'cocos-mcp-installer' }
        Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

        # GitHub 源码 zip 顶层目录名随分支变化，因此需要先确认唯一顶层目录。
        $archiveDir = Resolve-ArchiveRoot -ExtractRoot $extractRoot -ZipUrl $zipUrl

        $sourceDir = Join-Path $archiveDir.FullName 'plugin-package'
        $sourceItem = Get-Item -LiteralPath $sourceDir -ErrorAction SilentlyContinue
        if (-not $sourceItem) {
            throw "远程压缩包缺少 plugin-package: $sourceDir"
        }

        if (-not $sourceItem.PSIsContainer) {
            throw "远程压缩包中的 plugin-package 不是目录: $sourceDir"
        }

        New-Item -ItemType Directory -Path $targetExtensionsDir -Force | Out-Null
        Replace-PluginDirectoryAtomically -SourceDir $sourceDir -TargetExtensionsDir $targetExtensionsDir
        Write-Host "安装完成: $targetDir"
    } finally {
        if (Test-Path -LiteralPath $tempRoot) {
            Remove-Item -LiteralPath $tempRoot -Recurse -Force
        }
    }
}

try {
    $targetProjectPath = Resolve-TargetProjectPath -InputPath $ProjectPath
    Install-PluginPackage -Owner $RepoOwner -Repo $RepoName -TargetProjectPath $targetProjectPath
} catch {
    $message = $_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($message)) {
        $message = $_ | Out-String
    }

    Write-Error "安装 cocos-mcp-server 失败: $message"
    exit 1
}
