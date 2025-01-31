import * as pulumi from "@pulumi/pulumi";
import * as azure from "@pulumi/azure-nextgen";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import { workspace } from "./logs";
import { clusterSubnet } from "./vnet";
import env from "../environment";

const { resourceName, resourceGroup, deploymentName, config, Assignment } = env;

const kubernetesVersion = config.require("kubernetesVersion");

const password = new random.RandomPassword("password", {
  length: 20,
  special: true,
});
const sshKey = new tls.PrivateKey("ssh-key", {
  algorithm: "RSA",
  rsaBits: 4096,
});
const managedClusterName = resourceName("aks");
const nodesResourceGroupName = resourceGroup.name.apply(
  (name) => name + "-nodes"
);
export const cluster = new azure.containerservice.latest.ManagedCluster(
  managedClusterName,
  {
    resourceName: managedClusterName,
    resourceGroupName: resourceGroup.name,
    nodeResourceGroup: nodesResourceGroupName,
    location: resourceGroup.location,
    identity: {
      type: "SystemAssigned",
    },
    addonProfiles: {
      omsagent: {
        enabled: true,
        config: {
          logAnalyticsWorkspaceResourceID: workspace.id,
        },
      },
    },
    agentPoolProfiles: [
      {
        count: 1,
        enableAutoScaling: true,
        minCount: 1,
        maxCount: 4,
        maxPods: 30,
        mode: "System",
        name: "lin",
        nodeLabels: {},
        osType: "Linux",
        osDiskType: "Ephemeral",
        osDiskSizeGB: 30,
        type: "VirtualMachineScaleSets",
        vmSize: "Standard_D4s_v3",
        vnetSubnetID: clusterSubnet.id,
      },
    ],
    dnsPrefix: deploymentName,
    enableRBAC: true,
    kubernetesVersion: kubernetesVersion,
    linuxProfile: {
      adminUsername: "aksUser",
      ssh: {
        publicKeys: [
          {
            keyData: sshKey.publicKeyOpenssh,
          },
        ],
      },
    },
    windowsProfile: {
      adminUsername: "aksUser",
      adminPassword: password.result,
    },
    networkProfile: {
      networkPlugin: "azure",
      dnsServiceIP: "10.2.2.254",
      serviceCidr: "10.2.2.0/24",
      dockerBridgeCidr: "172.17.0.1/16",
    },
  }
);

const windowsConfig = config.getObject<WindowsConfig>("windows");
export const windowspool = windowsConfig?.enabled ?new azure.containerservice.latest.AgentPool(
  "windowspool",
  {
    agentPoolName: "win",
    resourceGroupName: resourceGroup.name,
    resourceName: cluster.name,
    count: 1,
    enableAutoScaling: true,
    minCount: 1,
    maxCount: 4,
    maxPods: 30,
    nodeLabels: {},
    osType: "Windows",
    osDiskType: "Ephemeral",
    osDiskSizeGB: 30,
    type: "VirtualMachineScaleSets",
    vmSize: "Standard_D4s_v3",
    vnetSubnetID: clusterSubnet.id,
    nodeTaints: ["os=windows:NoSchedule"],
  }
) : undefined;
export const clientId = cluster.identityProfile.apply(
  (identityProfile) => identityProfile?.kubeletidentity.objectId || ""
);
const includeContainerRegistry = config.getBoolean("includeContainerRegistry");
if(includeContainerRegistry){
  const acrName = new random.RandomUuid("acr-suffic").result.apply(uuid => "arc" + uuid.replace('-', '').substring(0,6));
  const acr = new azure.containerregistry.latest.Registry("acr", {
    registryName : acrName,
    resourceGroupName: resourceGroup.name,
    sku : {
      name : "Basic"
    }
  });
  const _ = new Assignment("ra-acr-aks2", {
    principalId: clientId,
    scope: acr.id,
    roleDefinitionName: "AcrPull",
  });
}

const acrResourceId = config.get("acrResourceId");
if (acrResourceId) {
  const _ = new Assignment("ra-acr-aks2", {
    principalId: clientId,
    scope: acrResourceId,
    roleDefinitionName: "AcrPull",
  });
}

const creds = pulumi
  .all([cluster.name, resourceGroup.name])
  .apply(([clusterName, rgName]) => {
    return azure.containerservice.latest.listManagedClusterUserCredentials({
      resourceGroupName: rgName,
      resourceName: clusterName,
    });
  });

const encoded = creds.kubeconfigs[0].value;

export const kubeconfig = encoded.apply((enc) =>
  Buffer.from(enc, "base64").toString()
);

export const k8sProvider = new k8s.Provider("aksK8s", {
  kubeconfig,
  suppressDeprecationWarnings: true,
});

interface WindowsConfig {
  enabled: boolean;
}
