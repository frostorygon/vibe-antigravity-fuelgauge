/**
 * Antigravity FuelGauge - Process Hunter
 * 自动检测 Antigravity Process并提取ConnectInfo
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as https from 'https';
import * as process from 'process';
import { WindowsStrategy, UnixStrategy } from './strategies';
import { logger } from '../shared/log_service';
import { EnvironmentScanResult, PlatformStrategy, ProcessInfo, ScanDiagnostics } from '../shared/types';
import { TIMING, PROCESS_NAMES, API_ENDPOINTS } from '../shared/constants';

const execAsync = promisify(exec);

/**
 * Process Hunter类
 * 负责ScanSystemProcess，找到 Antigravity Language Server
 */
export class ProcessHunter {
    private strategy: PlatformStrategy;
    private targetProcess: string;
    private lastDiagnostics: ScanDiagnostics = {
        scan_method: 'unknown',
        target_process: '',
        attempts: 0,
        found_candidates: 0,
    };

    constructor() {
        logger.debug('Initializing ProcessHunter...');
        logger.debug(`Platform: ${process.platform}, Arch: ${process.arch}`);

        if (process.platform === 'win32') {
            this.strategy = new WindowsStrategy();
            this.targetProcess = PROCESS_NAMES.windows;
            logger.debug('Using Windows Strategy');
        } else if (process.platform === 'darwin') {
            this.strategy = new UnixStrategy('darwin');
            this.targetProcess = process.arch === 'arm64' 
                ? PROCESS_NAMES.darwin_arm 
                : PROCESS_NAMES.darwin_x64;
            logger.debug('Using macOS Strategy');
        } else {
            this.strategy = new UnixStrategy('linux');
            this.targetProcess = PROCESS_NAMES.linux;
            logger.debug('Using Linux Strategy');
        }

        logger.debug(`Target Process: ${this.targetProcess}`);
    }

    /**
     * Scan environment，查找 Antigravity Process
     * @param maxAttempts 最大尝试次数（Default 3 次）
     */
    async scanEnvironment(maxAttempts: number = 3): Promise<EnvironmentScanResult | null> {
        logger.info(`Scanning environment, max attempts: ${maxAttempts}`);

        // 第一阶段：按Process名查找
        const resultByName = await this.scanByProcessName(maxAttempts);
        if (resultByName) {
            return resultByName;
        }

        // 第二阶段：按关键字查找（备用方案）
        logger.info('Process name search failed, trying keyword search (csrf_token)...');
        const resultByKeyword = await this.scanByKeyword();
        if (resultByKeyword) {
            return resultByKeyword;
        }

        // 所有方法都Failed了，Execute诊断
        await this.runDiagnostics();

        return null;
    }

    /**
     * Get最近一次ScanDiagnostics info
     */
    getLastDiagnostics(): ScanDiagnostics {
        return { ...this.lastDiagnostics };
    }

    /**
     * 按Process名Scan
     */
    private async scanByProcessName(maxAttempts: number): Promise<EnvironmentScanResult | null> {
        let powershellTimeoutRetried = false; // 追踪 PowerShell Timeout是否已Retry过
        this.lastDiagnostics = {
            scan_method: 'process_name',
            target_process: this.targetProcess,
            attempts: maxAttempts,
            found_candidates: 0,
        };

        for (let i = 0; i < maxAttempts; i++) {
            logger.debug(`Attempt ${i + 1}/${maxAttempts} (by process name)...`);

            try {
                const cmd = this.strategy.getProcessListCommand(this.targetProcess);
                logger.debug(`Executing: ${cmd}`);

                const { stdout, stderr } = await execAsync(cmd, {
                    timeout: TIMING.PROCESS_CMD_TIMEOUT_MS,
                });

                // Record stderr 以便Debug
                if (stderr && stderr.trim()) {
                    logger.warn(`Command stderr: ${stderr.substring(0, 500)}`);
                }

                // Check stdout 是否为空或仅包含空白
                if (!stdout || !stdout.trim()) {
                    logger.debug('Command returned empty output, process may not be running');
                    continue;
                }

                const candidates = this.strategy.parseProcessInfo(stdout);

                if (candidates && candidates.length > 0) {
                    logger.info(`Found ${candidates.length} candidate process(es)`);
                    this.lastDiagnostics.found_candidates = candidates.length;
                    
                    // 遍历所有候选Process尝试Connect
                    for (const info of candidates) {
                        logger.info(`🔍 Checking Process: PID=${info.pid}, ExtPort=${info.extensionPort}`);
                        const result = await this.verifyAndConnect(info);
                        if (result) {
                            return result;
                        }
                    }
                    logger.warn('❌ All candidates failed verification in this attempt');
                }
            } catch (e) {
                const error = e instanceof Error ? e : new Error(String(e));
                const errorMsg = error.message.toLowerCase();
                
                // 构建详细的ErrorInfo
                const detailMsg = `Attempt ${i + 1} failed: ${error.message}`;
                logger.error(detailMsg);

                // Windows 特定Handle
                if (process.platform === 'win32' && this.strategy instanceof WindowsStrategy) {
                    
                    // 检测 PowerShell Execute策略Issue
                    if (errorMsg.includes('cannot be loaded because running scripts is disabled') ||
                        errorMsg.includes('executionpolicy') ||
                        errorMsg.includes('禁止Running脚本')) {
                        logger.error('⚠️ PowerShell execution policy may be blocking scripts. Try running: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned');
                    }
                    
                    // 检测 WMI ServiceIssue（仍保留Tooltip，因为 Get-CimInstance 依赖 WMI Service）
                    if (errorMsg.includes('rpc server') || 
                        errorMsg.includes('wmi') ||
                        errorMsg.includes('invalid class') ||
                        errorMsg.includes('Invalid类')) {
                        logger.error('⚠️ WMI service may not be running. Try: net start winmgmt');
                    }

                    // PowerShell Timeout特殊Handle：首次Timeout不消耗Retry次数
                    if (!powershellTimeoutRetried &&
                        (errorMsg.includes('timeout') ||
                         errorMsg.includes('timed out') ||
                         errorMsg.includes('Timeout'))) {
                        logger.warn('PowerShell command timed out (likely cold start), retrying with longer wait...');
                        powershellTimeoutRetried = true;
                        // 不消耗Retry次数，给 PowerShell 更多预热Time后Retry
                        i--;
                        await new Promise(r => setTimeout(r, 3000)); // 增加到 3 秒让 PowerShell 预热
                        continue;
                    }
                }
            }

            if (i < maxAttempts - 1) {
                await new Promise(r => setTimeout(r, TIMING.PROCESS_SCAN_RETRY_MS));
            }
        }

        return null;
    }

    /**
     * 按关键字Scan（查找包含 csrf_token 的Process）
     */
    private async scanByKeyword(): Promise<EnvironmentScanResult | null> {
        // 仅 Windows 支持按关键字查找
        if (process.platform !== 'win32' || !(this.strategy instanceof WindowsStrategy)) {
            return null;
        }

        this.lastDiagnostics = {
            scan_method: 'keyword',
            target_process: this.targetProcess,
            attempts: 1,
            found_candidates: 0,
        };

        const winStrategy = this.strategy as WindowsStrategy;
        // 注意：WindowsStrategy 现已纯化为仅使用 PowerShell，无需Check isUsingPowershell

        try {
            const cmd = winStrategy.getProcessByKeywordCommand();
            logger.debug(`Keyword search command: ${cmd}`);

            const { stdout, stderr } = await execAsync(cmd, { 
                timeout: TIMING.PROCESS_CMD_TIMEOUT_MS, 
            });

            if (stderr) {
                logger.warn(`StdErr: ${stderr}`);
            }

            const candidates = this.strategy.parseProcessInfo(stdout);

            if (candidates && candidates.length > 0) {
                logger.info(`Found ${candidates.length} keyword candidate(s)`);
                this.lastDiagnostics.found_candidates = candidates.length;
                
                for (const info of candidates) {
                    logger.info(`🔍 Checking Keyword Candidate: PID=${info.pid}`);
                    const result = await this.verifyAndConnect(info);
                    if (result) {
                        return result;
                    }
                }
            }
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            logger.error(`Keyword search failed: ${error.message}`);
        }

        return null;
    }

    /**
     * Validate并建立Connect
     */
    private async verifyAndConnect(info: ProcessInfo): Promise<EnvironmentScanResult | null> {
        const ports = await this.identifyPorts(info.pid);
        logger.debug(`Listening Ports: ${ports.join(', ')}`);
        this.lastDiagnostics.ports = ports;

        if (ports.length > 0) {
            const validPort = await this.verifyConnection(ports, info.csrfToken);
            this.lastDiagnostics.verified_port = validPort ?? null;
            this.lastDiagnostics.verification_success = Boolean(validPort);

            if (validPort) {
                logger.info(`✅ Connection Logic Verified: ${validPort}`);
                return {
                    extensionPort: info.extensionPort,
                    connectPort: validPort,
                    csrfToken: info.csrfToken,
                };
            }
        }

        return null;
    }

    /**
     * Running诊断命令，列出所有相关Process
     */
    private async runDiagnostics(): Promise<void> {
        logger.warn('⚠️ All scan attempts failed, running diagnostics...');
        logger.info(`Target process name: ${this.targetProcess}`);
        logger.info(`Platform: ${process.platform}, Arch: ${process.arch}`);
        
        // Windows 特定诊断
        if (process.platform === 'win32') {
            logger.info('📋 Windows Troubleshooting Tips:');
            logger.info('  1. Ensure Antigravity/Windsurf is running');
            logger.info('  2. Check if language_server_windows_x64.exe is in Task Manager');
            logger.info('  3. Try restarting Antigravity/VS Code');
            logger.info('  4. If PowerShell errors occur, try: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned');
            logger.info('  5. If WMI errors occur, try: net start winmgmt (run as admin)');
        }
        
        try {
            const diagCmd = this.strategy.getDiagnosticCommand();
            logger.debug(`Diagnostic command: ${diagCmd}`);
            
            const { stdout, stderr } = await execAsync(diagCmd, { timeout: 10000 });
            
            // 脱敏Handle：Hidden csrf_token，防止在Log中泄露敏感Info
            const sanitize = (text: string) => text.replace(/(--csrf_token[=\s]+)([a-f0-9-]+)/gi, '$1***REDACTED***');
            if (stdout && stdout.trim()) {
                logger.info(`📋 Related processes found:\n${sanitize(stdout).substring(0, 2000)}`);
            } else {
                logger.warn('❌ No related processes found (language_server/antigravity)');
                logger.info('💡 This usually means Antigravity is not running or the process name has changed.');
            }
            
            if (stderr && stderr.trim()) {
                logger.warn(`Diagnostic stderr: ${sanitize(stderr).substring(0, 500)}`);
            }
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            logger.error(`Diagnostic command failed: ${error.message}`);
            
            // 为User提供进一步的诊断Suggestion
            if (process.platform === 'win32') {
                logger.info('💡 Try running this command manually in PowerShell to debug:');
                logger.info('   Get-Process | Where-Object { $_.ProcessName -match "language|antigravity" }');
            } else {
                logger.info('💡 Try running this command manually in Terminal to debug:');
                logger.info('   ps aux | grep -E "language|antigravity"');
            }
        }
    }

    /**
     * 识别ProcessListen的Port
     */
    private async identifyPorts(pid: number): Promise<number[]> {
        try {
            // 确保Port检测命令可用（Unix Platform）
            if (this.strategy instanceof UnixStrategy) {
                await this.strategy.ensurePortCommandAvailable();
            }
            
            const cmd = this.strategy.getPortListCommand(pid);
            const { stdout } = await execAsync(cmd);
            return this.strategy.parseListeningPorts(stdout);
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            logger.error(`Port identification failed: ${error.message}`);
            return [];
        }
    }

    /**
     * ValidatePortConnect
     */
    private async verifyConnection(ports: number[], token: string): Promise<number | null> {
        for (const port of ports) {
            if (await this.pingPort(port, token)) {
                return port;
            }
        }
        return null;
    }

    /**
     * TestPort是否可用
     */
    private pingPort(port: number, token: string): Promise<boolean> {
        return new Promise(resolve => {
            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port,
                path: API_ENDPOINTS.GET_UNLEASH_DATA,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Codeium-Csrf-Token': token,
                    'Connect-Protocol-Version': '1',
                },
                rejectUnauthorized: false,
                timeout: TIMING.PROCESS_CMD_TIMEOUT_MS,
                agent: false, // 绕过代理，直接Connect localhost
            };

            const req = https.request(options, res => resolve(res.statusCode === 200));
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.write(JSON.stringify({ wrapper_data: {} }));
            req.end();
        });
    }

    /**
     * GetErrorInfo
     */
    getErrorMessages(): { processNotFound: string; commandNotAvailable: string; requirements: string[] } {
        return this.strategy.getErrorMessages();
    }
}

// 保持向后兼容
export type environment_scan_result = EnvironmentScanResult;
