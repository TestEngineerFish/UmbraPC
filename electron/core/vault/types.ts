// 密码保险箱 数据模型（三层 + 模块化控件）。渲染层同名类型自行声明（跨 tsconfig 不共享）。

export interface VaultMeta {
  v: number;                 // 版本
  kdf?: string;              // 密钥派生：pbkdf2（默认，跨端）| scrypt（旧本地库，解锁时自动迁移）
  salt: string;              // base64，KDF 盐（账户级）
  verifier: string;          // hex，SHA256(authHash)，服务器/本地校验主密码
  secretKeyEnc: string;      // base64，safeStorage 加密后的 Secret Key（设备绑定）
  vaults: VaultInfo[];       // 身份库列表 + 各自被 AUK 包装的 VaultKey
  autoLockMin: number;       // 自动锁定分钟（0=不自动锁）
  quickUnlockEnc?: string;   // 启用 Touch ID 快速解锁后：safeStorage 加密的 AUK（生物识别通过即解锁）
  syncRev?: number;          // 端到端同步：本地已基于的云端版本号
  trashCount?: number;       // 回收站条数（**明文**，只为锁着时能显示「N 项 · 解锁后可查看」）
  createdAt: number;
}
export interface VaultInfo {
  id: string;
  name: string;
  owner: string;             // self / dad / mom / wife / 自定义
  icon: string;
  order: number;
  keyWrapped: string;        // 被 AUK 包装的 VaultKey 密文（wrapKey）
}

// 类型（文件夹）：每个身份库各自一套。
export interface VaultType { id: string; name: string; icon: string; order: number }

// 附件元数据（字节单独加密存文件）。
export interface Attachment { id: string; name: string; mime: string; size: number; w?: number; h?: number; addedAt: number }

// 控件（Block）：type ∈ account/secret/text/field/images/files。
export interface Block { id: string; type: string; label?: string; data: Record<string, unknown> }

// 记录。
export interface Item {
  id: string;
  typeId: string;            // 所属类型（可改=移动）
  title: string;
  icon?: string;
  favorite?: boolean;
  tags?: string[];
  blocks: Block[];
  attachments: Attachment[];
  createdAt: number;
  updatedAt: number;
  revision: number;
  // 删除墓碑：标记删除后仍参与同步（界面过滤），让删除能跨端传播。
  // **一个标志位表示两种状态**（回收站，2026-08-23）：
  //   deleted=true 且 blocks/attachments 还在 → 在回收站里，30 天内能恢复
  //   deleted=true 且内容全空                 → 已彻底删除
  // 没有为回收站另加字段：iOS 的 VItem 是 Swift Codable，会把不认识的字段丢掉，
  // 新字段在混版本同步里会被抹平，那条记录就在所有设备上复活了。详见 index.ts 里那段。
  deleted?: boolean;
}

// 一个身份库解密后的内容（存 v-<id>.enc）。
export interface VaultData { types: VaultType[]; items: Item[] }
